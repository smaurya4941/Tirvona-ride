import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { getConnectionToken } from "@nestjs/mongoose";
import { Test } from "@nestjs/testing";
import { MongoMemoryServer } from "mongodb-memory-server";
import type { Connection } from "mongoose";
import request from "supertest";
import type { App } from "supertest/types";
import { WhatsAppDeliveryError, WhatsAppGateway } from "../src/modules/whatsapp/whatsapp.gateway";
import type { AuthenticationCodeMessage, WhatsAppSendResult } from "../src/modules/whatsapp/whatsapp.gateway";

/**
 * Login with a WhatsApp code (docs/auth/otp-login.md): the passwordless
 * alternative to POST /auth/login. Password login must keep working
 * unchanged next to it.
 */

class FakeWhatsApp extends WhatsAppGateway {
  readonly provider = "fake";
  readonly sent: AuthenticationCodeMessage[] = [];
  failNext = false;

  lastCodeFor(phone: string): string {
    const message = [...this.sent].reverse().find((item) => item.to === phone);
    if (!message) throw new Error(`no code sent to ${phone}`);
    return message.code;
  }

  countFor(phone: string): number {
    return this.sent.filter((item) => item.to === phone).length;
  }

  async sendAuthenticationCode(message: AuthenticationCodeMessage): Promise<WhatsAppSendResult> {
    if (this.failNext) {
      this.failNext = false;
      throw new WhatsAppDeliveryError("UNAVAILABLE", "fake outage");
    }
    this.sent.push(message);
    return { messageId: `wamid.fake.${this.sent.length}` };
  }
}

const PASSWORD = "Password@123";
const MAX_ATTEMPTS = 5;
const MAX_SENDS = 10;

const wrongCode = (code: string): string => (code === "000000" ? "111111" : "000000");

interface Session {
  accessToken: string;
  refreshToken: string;
  user: { id: string; phone: string; role: string; isPhoneVerified: boolean; lastLoginAt?: string };
}

describe("Login with a WhatsApp code (e2e)", () => {
  const originalCwd = process.cwd();
  const whatsapp = new FakeWhatsApp();
  let workDir: string;
  let mongo: MongoMemoryServer;
  let app: INestApplication<App>;
  let db: Connection;
  let phoneCounter = 0;

  const api = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const nextPhone = () => `+9195000${String(++phoneCounter).padStart(5, "0")}`;

  const skipCooldown = (phone: string, purpose: string) =>
    db
      .collection("otp_send_quotas")
      .updateOne({ phone, purpose }, { $set: { lastSentAt: new Date(Date.now() - 10 * 60_000) } });

  const signUp = async (role: "CUSTOMER" | "DRIVER" = "CUSTOMER"): Promise<Session> => {
    const phone = nextPhone();
    const started = await api()
      .post("/api/v1/auth/register")
      .send({ firstName: "Ravi", phone, password: PASSWORD, role })
      .expect(202);
    const verified = await api()
      .post("/api/v1/auth/verify-otp")
      .send({ phone, otp: whatsapp.lastCodeFor(phone), verificationId: started.body.data.verificationId })
      .expect(200);
    return verified.body.data as Session;
  };

  const requestCode = (phone: string) => api().post("/api/v1/auth/login/otp/request").send({ phone });
  const verifyCode = (phone: string, otp: string, deviceId = "device-otp") =>
    api().post("/api/v1/auth/login/otp/verify").send({ phone, otp, deviceId, deviceType: "android" });
  const passwordLogin = (phone: string, password = PASSWORD) =>
    api().post("/api/v1/auth/login").send({ phone, password });

  /** request → code → session, in one step. */
  const otpLogin = async (phone: string): Promise<Session> => {
    await requestCode(phone).expect(200);
    return (await verifyCode(phone, whatsapp.lastCodeFor(phone)).expect(200)).body.data as Session;
  };

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 60_000 } });
    workDir = await mkdtemp(join(tmpdir(), "tirvona-ride-otp-login-"));
    process.chdir(workDir);
    Object.assign(process.env, {
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      SWAGGER_ENABLED: "false",
      MONGODB_URI: mongo.getUri(),
      MONGODB_DB_NAME: "tirvona_ride_otp_login",
      REDIS_URL: "",
      THROTTLE_LIMIT: "1000",
      THROTTLE_AUTH_LIMIT: "1000",
      THROTTLE_SIGNUP_LIMIT: "1000",
      THROTTLE_OTP_SEND_LIMIT: "1000",
      THROTTLE_OTP_VERIFY_LIMIT: "1000",
      THROTTLE_REFRESH_LIMIT: "1000",
      BROADCAST_WORKER_INTERVAL_MS: "0",
      PAYMENT_RECONCILE_INTERVAL_MS: "0",
      MATCHING_SWEEP_INTERVAL_MS: "0",
      JWT_ACCESS_SECRET: randomBytes(48).toString("base64url"),
      JWT_REFRESH_SECRET: randomBytes(48).toString("base64url"),
      OTP_HASH_SECRET: randomBytes(48).toString("base64url"),
      WHATSAPP_PROVIDER: "log",
      OTP_TTL_SECONDS: "300",
      OTP_MAX_ATTEMPTS: String(MAX_ATTEMPTS),
      OTP_RESEND_COOLDOWN_SECONDS: "60",
      OTP_MAX_SENDS_PER_WINDOW: String(MAX_SENDS),
      OTP_SEND_WINDOW_MINUTES: "60",
    });

    const { AppModule } = await import("../src/app.module");
    const { configureApp } = await import("../src/app.setup");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(WhatsAppGateway)
      .useValue(whatsapp)
      .compile();
    app = moduleRef.createNestApplication({ logger: false, rawBody: true });
    configureApp(app);
    await app.init();
    db = app.get<Connection>(getConnectionToken());
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
    process.chdir(originalCwd);
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  it("signs in end to end with the same session password login returns", async () => {
    const account = await signUp();
    const phone = account.user.phone;

    const challenge = (await requestCode(phone).expect(200)).body.data;
    expect(challenge).toMatchObject({ phone, channel: "WHATSAPP", codeLength: 6, codeSent: true, maskedPhone: expect.any(String) });
    expect(challenge.resendAvailableInSeconds).toBeGreaterThan(0);
    expect(challenge).not.toHaveProperty("code");
    expect(challenge).not.toHaveProperty("verificationId");
    // Only an HMAC is stored, under its own purpose.
    const record = await db.collection("otp_verifications").findOne({ phone, purpose: "LOGIN" });
    expect(record).toBeTruthy();
    expect(JSON.stringify(record)).not.toContain(whatsapp.lastCodeFor(phone));

    const session = (await verifyCode(phone, whatsapp.lastCodeFor(phone)).expect(200)).body.data as Session;
    expect(session).toMatchObject({ accessToken: expect.any(String), refreshToken: expect.any(String) });
    expect(session.user).toMatchObject({ id: account.user.id, phone, role: "CUSTOMER", isPhoneVerified: true });
    expect(session.user.lastLoginAt).toEqual(expect.any(String));
    // The same shape as password login.
    const viaPassword = (await passwordLogin(phone).expect(200)).body.data as Session;
    expect(Object.keys(session).sort()).toEqual(Object.keys(viaPassword).sort());
    expect(Object.keys(session.user).sort()).toEqual(Object.keys(viaPassword.user).sort());

    // The session works and refreshes; the device was recorded.
    await api().get("/api/v1/auth/me").set(bearer(session.accessToken)).expect(200);
    await api().post("/api/v1/auth/refresh").send({ refreshToken: session.refreshToken }).expect(200);
    expect(await db.collection("user_sessions").countDocuments({ deviceId: "device-otp" })).toBeGreaterThan(0);

    // Single use: the record is gone and the code cannot be replayed.
    expect(await db.collection("otp_verifications").countDocuments({ phone, purpose: "LOGIN" })).toBe(0);
    await verifyCode(phone, whatsapp.lastCodeFor(phone)).expect(400, /OTP_NOT_ACTIVE/);
  });

  it("signs drivers in too, with their driver status", async () => {
    const driver = await signUp("DRIVER");
    const session = await otpLogin(driver.user.phone);
    expect(session.user.role).toBe("DRIVER");
    expect(session.user).toMatchObject({ driver: { driverStatus: "PENDING" } });
  });

  it("accepts the number in any local form", async () => {
    const { user } = await signUp();
    const local = user.phone.replace("+91", "");
    expect((await requestCode(local).expect(200)).body.data.phone).toBe(user.phone);
    await verifyCode(`0${local}`, whatsapp.lastCodeFor(user.phone)).expect(200);
  });

  it("tells the user when no account uses the number, and sends nothing", async () => {
    const unknown = nextPhone();
    await requestCode(unknown).expect(404, /ACCOUNT_NOT_FOUND/);
    await verifyCode(unknown, "123456").expect(404, /ACCOUNT_NOT_FOUND/);
    expect(whatsapp.countFor(unknown)).toBe(0);
    expect(await db.collection("otp_send_quotas").countDocuments({ phone: unknown })).toBe(0);
  });

  it("keeps admins password-only: they look like unknown numbers", async () => {
    const adminPhone = nextPhone();
    await db.collection("users").insertOne({
      phone: adminPhone,
      role: "ADMIN",
      status: "ACTIVE",
      firstName: "Admin",
      isPhoneVerified: true,
      isEmailVerified: false,
    });
    await requestCode(adminPhone).expect(404, /ACCOUNT_NOT_FOUND/);
    await verifyCode(adminPhone, "123456").expect(404, /ACCOUNT_NOT_FOUND/);
    expect(whatsapp.countFor(adminPhone)).toBe(0);
  });

  it("refuses blocked accounts, also when the block lands after the code was sent", async () => {
    const blocked = await signUp();
    await db.collection("users").updateOne({ phone: blocked.user.phone }, { $set: { status: "BLOCKED" } });
    const before = whatsapp.countFor(blocked.user.phone);
    await requestCode(blocked.user.phone).expect(403, /USER_BLOCKED/);
    expect(whatsapp.countFor(blocked.user.phone)).toBe(before);

    const later = await signUp();
    await requestCode(later.user.phone).expect(200);
    await db.collection("users").updateOne({ phone: later.user.phone }, { $set: { status: "BLOCKED" } });
    await verifyCode(later.user.phone, whatsapp.lastCodeFor(later.user.phone)).expect(403, /USER_BLOCKED/);
    // The code was not spent; unblocking lets the user finish.
    await db.collection("users").updateOne({ phone: later.user.phone }, { $set: { status: "ACTIVE" } });
    await verifyCode(later.user.phone, whatsapp.lastCodeFor(later.user.phone)).expect(200);
  });

  it("counts wrong codes, then locks the code until a new one is sent", async () => {
    const { user } = await signUp();
    await verifyCode(user.phone, "123456").expect(400, /OTP_NOT_ACTIVE/);
    await requestCode(user.phone).expect(200);
    const code = whatsapp.lastCodeFor(user.phone);

    const first = await verifyCode(user.phone, wrongCode(code)).expect(400, /OTP_INVALID/);
    expect(first.body.data).toEqual({ attemptsRemaining: MAX_ATTEMPTS - 1 });
    for (let attempt = 2; attempt < MAX_ATTEMPTS; attempt++)
      await verifyCode(user.phone, wrongCode(code)).expect(400, /OTP_INVALID/);
    await verifyCode(user.phone, wrongCode(code)).expect(400, /OTP_TOO_MANY_ATTEMPTS/);
    await verifyCode(user.phone, code).expect(400, /OTP_TOO_MANY_ATTEMPTS/);

    // A locked code does not hold back a fresh one.
    await skipCooldown(user.phone, "LOGIN");
    await requestCode(user.phone).expect(200);
    await verifyCode(user.phone, whatsapp.lastCodeFor(user.phone)).expect(200);
  });

  it("rejects an expired code", async () => {
    const { user } = await signUp();
    await requestCode(user.phone).expect(200);
    await db
      .collection("otp_verifications")
      .updateOne({ phone: user.phone, purpose: "LOGIN" }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    await verifyCode(user.phone, whatsapp.lastCodeFor(user.phone)).expect(400, /OTP_EXPIRED/);
  });

  it("keeps the code already sent inside the cooldown; a resend after it kills the old code", async () => {
    const { user } = await signUp();
    await requestCode(user.phone).expect(200);
    const first = whatsapp.lastCodeFor(user.phone);
    const sentBefore = whatsapp.countFor(user.phone);

    const again = (await requestCode(user.phone).expect(200)).body.data;
    expect(again.codeSent).toBe(false);
    expect(again.resendAvailableInSeconds).toBeGreaterThan(0);
    expect(whatsapp.countFor(user.phone)).toBe(sentBefore);

    await skipCooldown(user.phone, "LOGIN");
    const resent = (await requestCode(user.phone).expect(200)).body.data;
    expect(resent.codeSent).toBe(true);
    expect(resent.sendsRemaining).toBe(MAX_SENDS - 2);
    const second = whatsapp.lastCodeFor(user.phone);
    if (first !== second) await verifyCode(user.phone, first).expect(400, /OTP_INVALID/);
    await verifyCode(user.phone, second).expect(200);
  });

  it("has its own send budget, separate from signup and password reset", async () => {
    const { user } = await signUp();
    await requestCode(user.phone).expect(200);
    await db
      .collection("otp_send_quotas")
      .updateOne(
        { phone: user.phone, purpose: "LOGIN" },
        { $set: { sendCount: MAX_SENDS, lastSentAt: new Date(Date.now() - 10 * 60_000) } },
      );
    const limited = await requestCode(user.phone).expect(429, /OTP_SEND_LIMIT_REACHED/);
    expect(limited.body.data.retryAfterSeconds).toBeGreaterThan(0);

    // Forgot password still has its full budget, and password login is untouched.
    await api().post("/api/v1/auth/password/forgot").send({ phone: user.phone }).expect(200);
    await passwordLogin(user.phone).expect(200);
  });

  it("never accepts a code issued for another flow, nor lets a login code serve one", async () => {
    const { user } = await signUp();

    // A password-reset code cannot sign in…
    await api().post("/api/v1/auth/password/forgot").send({ phone: user.phone }).expect(200);
    const resetCode = whatsapp.lastCodeFor(user.phone);
    await requestCode(user.phone).expect(200);
    const loginCode = whatsapp.lastCodeFor(user.phone);
    if (resetCode !== loginCode) await verifyCode(user.phone, resetCode).expect(400, /OTP_INVALID/);

    // …and a login code cannot reset the password.
    if (resetCode !== loginCode)
      await api()
        .post("/api/v1/auth/password/verify-otp")
        .send({ phone: user.phone, otp: loginCode })
        .expect(400, /OTP_INVALID/);
    await verifyCode(user.phone, loginCode).expect(200);
    // The reset code is still the reset flow's own.
    await api().post("/api/v1/auth/password/verify-otp").send({ phone: user.phone, otp: resetCode }).expect(200);

    // A signup code for a number cannot sign anyone in, even once an account exists.
    const phone = nextPhone();
    await api()
      .post("/api/v1/auth/register")
      .send({ firstName: "Mira", phone, password: PASSWORD, role: "CUSTOMER" })
      .expect(202);
    const signupCode = whatsapp.lastCodeFor(phone);
    await db.collection("users").insertOne({
      phone,
      role: "CUSTOMER",
      status: "ACTIVE",
      firstName: "Mira",
      isPhoneVerified: true,
      isEmailVerified: false,
    });
    await verifyCode(phone, signupCode).expect(400, /OTP_NOT_ACTIVE/);
  });

  it("lets exactly one of several parallel verifications win", async () => {
    const { user } = await signUp();
    await requestCode(user.phone).expect(200);
    const code = whatsapp.lastCodeFor(user.phone);
    const results = await Promise.all(Array.from({ length: 5 }, () => verifyCode(user.phone, code)));
    expect(results.filter((response) => response.status === 200)).toHaveLength(1);
    for (const response of results.filter((item) => item.status !== 200)) {
      expect(response.status).toBe(400);
      expect(response.body.code).toBe("OTP_NOT_ACTIVE");
    }
  });

  it("verifies the phone of an account created before signup OTP", async () => {
    const legacy = await signUp();
    await db.collection("users").updateOne({ phone: legacy.user.phone }, { $set: { isPhoneVerified: false } });
    expect((await passwordLogin(legacy.user.phone).expect(200)).body.data.user.isPhoneVerified).toBe(false);

    const session = await otpLogin(legacy.user.phone);
    expect(session.user.isPhoneVerified).toBe(true);
    expect((await db.collection("users").findOne({ phone: legacy.user.phone }))?.isPhoneVerified).toBe(true);
  });

  it("never claims a code was sent when WhatsApp delivery fails, and does not count it", async () => {
    const { user } = await signUp();
    whatsapp.failNext = true;
    await requestCode(user.phone).expect(503, /OTP_DELIVERY_FAILED/);
    expect(await db.collection("otp_verifications").countDocuments({ phone: user.phone, purpose: "LOGIN" })).toBe(0);
    // No cooldown was started by the failed send.
    const retried = (await requestCode(user.phone).expect(200)).body.data;
    expect(retried).toMatchObject({ codeSent: true, sendsRemaining: MAX_SENDS - 1 });
  });

  it("validates input and refuses unknown fields", async () => {
    await requestCode("12345").expect(400);
    await api().post("/api/v1/auth/login/otp/request").send({}).expect(400);
    const { user } = await signUp();
    await verifyCode(user.phone, "12ab56").expect(400);
    await verifyCode(user.phone, "1234567").expect(400);
    await api()
      .post("/api/v1/auth/login/otp/verify")
      .send({ phone: user.phone, otp: "123456", role: "ADMIN" })
      .expect(400);
  });

  it("leaves password login exactly as it was", async () => {
    const { user } = await signUp();
    await passwordLogin(user.phone).expect(200);
    await passwordLogin(user.phone, "Wrong#Pass1").expect(401, /AUTH_INVALID_CREDENTIALS/);
    await passwordLogin(nextPhone()).expect(401, /AUTH_INVALID_CREDENTIALS/);
    // Signing in with a code changes nothing about the password.
    await otpLogin(user.phone);
    await passwordLogin(user.phone).expect(200);
  });
});
