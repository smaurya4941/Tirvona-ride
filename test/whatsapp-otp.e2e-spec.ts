import { createHash, randomBytes } from "node:crypto";
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
import type {
  AuthenticationCodeMessage,
  WhatsAppFailureReason,
  WhatsAppSendResult,
} from "../src/modules/whatsapp/whatsapp.gateway";

/**
 * Signup with WhatsApp OTP (docs/auth/whatsapp-otp.md) — the plan's normal,
 * failure and security test matrix against the real HTTP surface. Meta is
 * replaced by an in-memory gateway that records every code "sent".
 */

class FakeWhatsApp extends WhatsAppGateway {
  readonly provider = "fake";
  readonly sent: AuthenticationCodeMessage[] = [];
  private failures: WhatsAppFailureReason[] = [];

  failNext(reason: WhatsAppFailureReason): void {
    this.failures.push(reason);
  }

  lastCodeFor(phone: string): string {
    const message = [...this.sent].reverse().find((item) => item.to === phone);
    if (!message) throw new Error(`no code sent to ${phone}`);
    return message.code;
  }

  countFor(phone: string): number {
    return this.sent.filter((item) => item.to === phone).length;
  }

  async sendAuthenticationCode(message: AuthenticationCodeMessage): Promise<WhatsAppSendResult> {
    const failure = this.failures.shift();
    if (failure) throw new WhatsAppDeliveryError(failure, `fake ${failure}`);
    this.sent.push(message);
    return { messageId: `wamid.fake.${this.sent.length}` };
  }
}

const PASSWORD = "Password@123";
const MAX_ATTEMPTS = 5;
const MAX_SENDS = 4;

const wrongCode = (code: string): string => (code === "000000" ? "111111" : "000000");

describe("Signup — WhatsApp OTP (e2e)", () => {
  const originalCwd = process.cwd();
  const whatsapp = new FakeWhatsApp();
  let workDir: string;
  let mongo: MongoMemoryServer;
  let app: INestApplication<App>;
  let db: Connection;
  let phoneCounter = 0;

  const api = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const nextPhone = () => `+9197000${String(++phoneCounter).padStart(5, "0")}`;

  const register = (phone: string, extra: Record<string, unknown> = {}) =>
    api()
      .post("/api/v1/auth/register")
      .send({ firstName: "Asha", lastName: "Verma", phone, password: PASSWORD, role: "CUSTOMER", ...extra });

  const verify = (phone: string, otp: string, verificationId: string) =>
    api().post("/api/v1/auth/verify-otp").send({ phone, otp, verificationId, deviceId: "device-1" });

  const resend = (phone: string, verificationId: string) =>
    api().post("/api/v1/auth/resend-otp").send({ phone, verificationId });

  /** Moves the per-number cooldown into the past, as if the user waited. */
  const skipCooldown = (phone: string, purpose = "SIGNUP") =>
    db
      .collection("otp_send_quotas")
      .updateOne({ phone, purpose }, { $set: { lastSentAt: new Date(Date.now() - 10 * 60_000) } });

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 60_000 } });
    workDir = await mkdtemp(join(tmpdir(), "tirvona-ride-otp-"));
    process.chdir(workDir);
    Object.assign(process.env, {
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      SWAGGER_ENABLED: "false",
      MONGODB_URI: mongo.getUri(),
      MONGODB_DB_NAME: "tirvona_ride_whatsapp_otp",
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

  // ── Normal flow ──────────────────────────────────────────────────────

  describe("normal flow", () => {
    it("register sends a WhatsApp code but creates no account yet", async () => {
      const phone = nextPhone();
      const response = await register(phone).expect(202);

      expect(response.body.data).toMatchObject({
        phone,
        maskedPhone: expect.stringMatching(/^\+91 \*{5} \*\d{4}$/),
        channel: "WHATSAPP",
        codeLength: 6,
        codeSent: true,
        resendAvailableInSeconds: 60,
        sendsRemaining: MAX_SENDS - 1,
        verificationId: expect.any(String),
      });
      expect(response.body.data.expiresInSeconds).toBeGreaterThan(290);
      // The code itself never comes back to the client.
      expect(JSON.stringify(response.body)).not.toContain(whatsapp.lastCodeFor(phone));
      expect(await db.collection("users").countDocuments({ phone })).toBe(0);
      // An unverified signup cannot sign in.
      await api().post("/api/v1/auth/login").send({ phone, password: PASSWORD }).expect(401);
    });

    it("verify-otp creates a phone-verified account and signs the user in", async () => {
      const phone = nextPhone();
      const { verificationId } = (await register(phone).expect(202)).body.data;

      const session = (await verify(phone, whatsapp.lastCodeFor(phone), verificationId).expect(200)).body.data;
      expect(session).toMatchObject({
        accessToken: expect.any(String),
        refreshToken: expect.any(String),
        user: { phone, role: "CUSTOMER", status: "ACTIVE", isPhoneVerified: true, firstName: "Asha" },
      });

      const me = (await api().get("/api/v1/auth/me").set(bearer(session.accessToken)).expect(200)).body.data;
      expect(me.isPhoneVerified).toBe(true);
      await api().post("/api/v1/auth/login").send({ phone, password: PASSWORD }).expect(200);

      // Code deleted immediately (not left for TTL); pending form gone too.
      expect(await db.collection("otp_verifications").countDocuments({ phone })).toBe(0);
      expect(await db.collection("pending_signups").countDocuments({ phone })).toBe(0);
    });

    it("driver signup lands in KYC (PENDING), not approval", async () => {
      const phone = nextPhone();
      const { verificationId } = (await register(phone, { role: "DRIVER" }).expect(202)).body.data;
      const session = (await verify(phone, whatsapp.lastCodeFor(phone), verificationId).expect(200)).body.data;
      expect(session.user).toMatchObject({ role: "DRIVER", isPhoneVerified: true, driver: { driverStatus: "PENDING" } });
    });

    it("normalises the phone number however it is typed", async () => {
      const response = await register("097000 99001").expect(202);
      expect(response.body.data.phone).toBe("+919700099001");
      expect(whatsapp.lastCodeFor("+919700099001")).toMatch(/^\d{6}$/);

      // Verifying with another spelling of the same number works.
      await verify("919700099001", whatsapp.lastCodeFor("+919700099001"), response.body.data.verificationId).expect(200);
      await api().post("/api/v1/auth/login").send({ phone: "97000 99001", password: PASSWORD }).expect(200);
    });

    it("rejects numbers that cannot be a mobile", async () => {
      const response = await register("+911123456789").expect(400);
      expect(response.body.message).toMatch(/valid mobile/);
      await register("12345").expect(400);
    });
  });

  // ── Wrong, expired, exhausted codes ──────────────────────────────────

  describe("verification failures", () => {
    it("rejects a wrong code and reports the attempts left", async () => {
      const phone = nextPhone();
      const { verificationId } = (await register(phone).expect(202)).body.data;
      const response = await verify(phone, wrongCode(whatsapp.lastCodeFor(phone)), verificationId).expect(400);
      expect(response.body).toMatchObject({ code: "OTP_INVALID", data: { attemptsRemaining: MAX_ATTEMPTS - 1 } });
    });

    it("blocks the code after the maximum attempts, even the right one", async () => {
      const phone = nextPhone();
      const { verificationId } = (await register(phone).expect(202)).body.data;
      const code = whatsapp.lastCodeFor(phone);
      for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1)
        expect((await verify(phone, wrongCode(code), verificationId).expect(400)).body.code).toBe("OTP_INVALID");
      expect((await verify(phone, wrongCode(code), verificationId).expect(400)).body.code).toBe("OTP_TOO_MANY_ATTEMPTS");
      expect((await verify(phone, code, verificationId).expect(400)).body.code).toBe("OTP_TOO_MANY_ATTEMPTS");

      // Resend is the way out.
      await skipCooldown(phone);
      await resend(phone, verificationId).expect(200);
      await verify(phone, whatsapp.lastCodeFor(phone), verificationId).expect(200);
    });

    it("parallel guesses cannot exceed the attempt limit", async () => {
      const phone = nextPhone();
      const { verificationId } = (await register(phone).expect(202)).body.data;
      const code = whatsapp.lastCodeFor(phone);
      await Promise.all(Array.from({ length: 12 }, () => verify(phone, wrongCode(code), verificationId)));
      const record = await db.collection("otp_verifications").findOne({ phone });
      expect(record?.attempts).toBe(MAX_ATTEMPTS);
    });

    it("rejects an expired code even before Mongo's TTL removes it", async () => {
      const phone = nextPhone();
      const { verificationId } = (await register(phone).expect(202)).body.data;
      await db
        .collection("otp_verifications")
        .updateOne({ phone }, { $set: { expiresAt: new Date(Date.now() - 1_000) } });
      const response = await verify(phone, whatsapp.lastCodeFor(phone), verificationId).expect(400);
      expect(response.body.code).toBe("OTP_EXPIRED");
    });
  });

  // ── Resend ───────────────────────────────────────────────────────────

  describe("resend", () => {
    it("enforces the cooldown on the server", async () => {
      const phone = nextPhone();
      const { verificationId } = (await register(phone).expect(202)).body.data;
      const response = await resend(phone, verificationId).expect(429);
      expect(response.body).toMatchObject({ code: "OTP_RESEND_TOO_SOON", data: { retryAfterSeconds: expect.any(Number) } });
      expect(response.body.data.retryAfterSeconds).toBeGreaterThan(50);
      expect(whatsapp.countFor(phone)).toBe(1);
    });

    it("invalidates the previous code: only the latest works", async () => {
      const phone = nextPhone();
      const { verificationId } = (await register(phone).expect(202)).body.data;
      const first = whatsapp.lastCodeFor(phone);

      await skipCooldown(phone);
      const resent = (await resend(phone, verificationId).expect(200)).body.data;
      expect(resent).toMatchObject({ codeSent: true, verificationId, sendsRemaining: MAX_SENDS - 2 });
      const second = whatsapp.lastCodeFor(phone);

      if (first !== second)
        expect((await verify(phone, first, verificationId).expect(400)).body.code).toBe("OTP_INVALID");
      await verify(phone, second, verificationId).expect(200);
    });

    it("caps codes per number per window", async () => {
      const phone = nextPhone();
      const { verificationId } = (await register(phone).expect(202)).body.data;
      for (let send = 2; send <= MAX_SENDS; send += 1) {
        await skipCooldown(phone);
        await resend(phone, verificationId).expect(200);
      }
      await skipCooldown(phone);
      const response = await resend(phone, verificationId).expect(429);
      expect(response.body.code).toBe("OTP_SEND_LIMIT_REACHED");
      // Re-submitting the form does not reset the budget either.
      await skipCooldown(phone);
      expect((await register(phone).expect(429)).body.code).toBe("OTP_SEND_LIMIT_REACHED");
      expect(whatsapp.countFor(phone)).toBe(MAX_SENDS);
    });

    it("re-submitting the form inside the cooldown keeps the code already sent", async () => {
      const phone = nextPhone();
      await register(phone).expect(202);
      const again = (await register(phone, { firstName: "Asha Rani" }).expect(202)).body.data;
      expect(again.codeSent).toBe(false);
      expect(again.resendAvailableInSeconds).toBeGreaterThan(0);
      expect(whatsapp.countFor(phone)).toBe(1);

      const session = (await verify(phone, whatsapp.lastCodeFor(phone), again.verificationId).expect(200)).body.data;
      // The latest submission wins.
      expect(session.user.firstName).toBe("Asha Rani");
    });
  });

  // ── Registration rules ───────────────────────────────────────────────

  describe("registration rules", () => {
    it("refuses a number that already has an account, without sending anything", async () => {
      const phone = nextPhone();
      const { verificationId } = (await register(phone).expect(202)).body.data;
      await verify(phone, whatsapp.lastCodeFor(phone), verificationId).expect(200);

      const sentBefore = whatsapp.sent.length;
      const response = await register(phone).expect(409);
      expect(response.body.code).toBe("PHONE_ALREADY_REGISTERED");
      expect(whatsapp.sent.length).toBe(sentBefore);
    });

    it("refuses an email another account uses", async () => {
      const first = nextPhone();
      const { verificationId } = (await register(first, { email: "Asha@Example.com" }).expect(202)).body.data;
      await verify(first, whatsapp.lastCodeFor(first), verificationId).expect(200);
      const response = await register(nextPhone(), { email: "asha@example.com" }).expect(409);
      expect(response.body.code).toBe("EMAIL_ALREADY_REGISTERED");
    });

    it("refuses self-registration as ADMIN and client-set verification flags", async () => {
      await register(nextPhone(), { role: "ADMIN" }).expect(400);
      await register(nextPhone(), { isPhoneVerified: true }).expect(400);
      await register(nextPhone(), { status: "ACTIVE" }).expect(400);
    });
  });

  // ── WhatsApp failures ────────────────────────────────────────────────

  describe("WhatsApp failures", () => {
    it("never answers 'sent' when Meta rejects the message, and does not count it", async () => {
      const phone = nextPhone();
      whatsapp.failNext("UNAVAILABLE");
      const response = await register(phone).expect(503);
      expect(response.body).toMatchObject({ success: false, code: "OTP_DELIVERY_FAILED" });
      expect(response.body.data).toBeUndefined();
      // No usable code or orphaned sign-up remains…
      expect(await db.collection("otp_verifications").countDocuments({ phone })).toBe(0);
      expect(await db.collection("pending_signups").countDocuments({ phone })).toBe(0);
      // …and the failed send did not start a cooldown.
      const retry = await register(phone).expect(202);
      expect(retry.body.data.sendsRemaining).toBe(MAX_SENDS - 1);
    });

    it("tells the user when the number is not reachable on WhatsApp", async () => {
      whatsapp.failNext("RECIPIENT_UNAVAILABLE");
      const response = await register(nextPhone()).expect(422);
      expect(response.body.code).toBe("WHATSAPP_RECIPIENT_UNAVAILABLE");
      expect(response.body.message).not.toMatch(/meta|graph|131026/i);
    });

    it("a failed resend leaves the sign-up usable", async () => {
      const phone = nextPhone();
      const { verificationId } = (await register(phone).expect(202)).body.data;
      await skipCooldown(phone);
      whatsapp.failNext("MISCONFIGURED");
      expect((await resend(phone, verificationId).expect(503)).body.code).toBe("OTP_DELIVERY_FAILED");
      await resend(phone, verificationId).expect(200);
      await verify(phone, whatsapp.lastCodeFor(phone), verificationId).expect(200);
    });
  });

  // ── Security ─────────────────────────────────────────────────────────

  describe("security", () => {
    it("a code cannot be reused after a successful verification", async () => {
      const phone = nextPhone();
      const { verificationId } = (await register(phone).expect(202)).body.data;
      const code = whatsapp.lastCodeFor(phone);
      await verify(phone, code, verificationId).expect(200);
      expect((await verify(phone, code, verificationId).expect(400)).body.code).toBe("SIGNUP_SESSION_INVALID");
    });

    it("a correct code wins exactly once under concurrency", async () => {
      const phone = nextPhone();
      const { verificationId } = (await register(phone).expect(202)).body.data;
      const code = whatsapp.lastCodeFor(phone);
      const results = await Promise.all([1, 2, 3].map(() => verify(phone, code, verificationId)));
      expect(results.filter((result) => result.status === 200)).toHaveLength(1);
      expect(await db.collection("users").countDocuments({ phone })).toBe(1);
    });

    it("a code cannot verify a different phone number", async () => {
      const phoneA = nextPhone();
      const phoneB = nextPhone();
      await register(phoneA).expect(202);
      const b = (await register(phoneB).expect(202)).body.data;
      const codeA = whatsapp.lastCodeFor(phoneA);
      const codeB = whatsapp.lastCodeFor(phoneB);
      if (codeA !== codeB)
        expect((await verify(phoneB, codeA, b.verificationId).expect(400)).body.code).toBe("OTP_INVALID");
    });

    it("needs the verificationId of the latest submission", async () => {
      const phone = nextPhone();
      const first = (await register(phone).expect(202)).body.data;
      const code = whatsapp.lastCodeFor(phone);
      expect((await verify(phone, code, "y".repeat(43)).expect(400)).body.code).toBe("SIGNUP_SESSION_INVALID");

      // Someone re-submits the form for this number: the earlier handle dies,
      // so the first submitter's password can't be swapped under the code.
      const second = (await register(phone, { password: "Other@Pass1" }).expect(202)).body.data;
      expect((await verify(phone, code, first.verificationId).expect(400)).body.code).toBe("SIGNUP_SESSION_INVALID");
      await verify(phone, code, second.verificationId).expect(200);
    });

    it("stores only an HMAC of the code, with a TTL index on expiresAt", async () => {
      const phone = nextPhone();
      await register(phone).expect(202);
      const code = whatsapp.lastCodeFor(phone);
      const record = await db.collection("otp_verifications").findOne({ phone });
      expect(record).toMatchObject({ purpose: "SIGNUP", attempts: 0, verified: false });
      expect(record?.otpHash).toMatch(/^[a-f0-9]{64}$/);
      expect(record?.otpHash).not.toContain(code);
      expect(record?.otpHash).not.toBe(createHash("sha256").update(code).digest("hex"));
      expect(JSON.stringify(record)).not.toContain(`"${code}"`);

      const pending = await db.collection("pending_signups").findOne({ phone });
      expect(pending?.passwordHash).toMatch(/^\$argon2/);
      expect(JSON.stringify(pending)).not.toContain(PASSWORD);

      for (const collection of ["otp_verifications", "otp_send_quotas", "pending_signups"]) {
        const indexes = await db.collection(collection).indexes();
        expect(indexes).toEqual(
          expect.arrayContaining([expect.objectContaining({ key: { expiresAt: 1 }, expireAfterSeconds: 0 })]),
        );
      }
    });

    it("the old public send-otp endpoint is gone", async () => {
      await api().post("/api/v1/auth/send-otp").send({ phone: nextPhone() }).expect(404);
    });
  });

  // ── Accounts created before signup OTP ───────────────────────────────

  describe("existing unverified accounts", () => {
    it("verify their own number while signed in", async () => {
      const phone = nextPhone();
      const { UsersService } = await import("../src/modules/users/users.service");
      const { UserRole } = await import("../src/common/types/user-role.enum");
      await app.get(UsersService).create({ phone, password: PASSWORD, role: UserRole.CUSTOMER, firstName: "Old" });

      const login = (await api().post("/api/v1/auth/login").send({ phone, password: PASSWORD }).expect(200)).body.data;
      expect(login.user.isPhoneVerified).toBe(false);
      await api().post("/api/v1/auth/phone/send-otp").expect(401);

      const sent = (await api().post("/api/v1/auth/phone/send-otp").set(bearer(login.accessToken)).expect(200)).body.data;
      expect(sent).toMatchObject({ phone, channel: "WHATSAPP", codeSent: true });
      expect(sent.verificationId).toBeUndefined();

      const user = (
        await api()
          .post("/api/v1/auth/phone/verify-otp")
          .set(bearer(login.accessToken))
          .send({ otp: whatsapp.lastCodeFor(phone) })
          .expect(200)
      ).body.data;
      expect(user.isPhoneVerified).toBe(true);

      const again = await api().post("/api/v1/auth/phone/send-otp").set(bearer(login.accessToken)).expect(409);
      expect(again.body.code).toBe("PHONE_ALREADY_VERIFIED");
    });
  });
});
