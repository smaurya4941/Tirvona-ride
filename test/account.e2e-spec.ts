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
import { WhatsAppGateway } from "../src/modules/whatsapp/whatsapp.gateway";
import type { AuthenticationCodeMessage, WhatsAppSendResult } from "../src/modules/whatsapp/whatsapp.gateway";

/**
 * Account self-service (docs/account/README.md): forgot password over
 * WhatsApp, sign out everywhere, profile edit, change password, profile
 * photo, and the rider's own labelled saved places.
 */

class FakeWhatsApp extends WhatsAppGateway {
  readonly provider = "fake";
  readonly sent: AuthenticationCodeMessage[] = [];

  lastCodeFor(phone: string): string {
    const message = [...this.sent].reverse().find((item) => item.to === phone);
    if (!message) throw new Error(`no code sent to ${phone}`);
    return message.code;
  }

  countFor(phone: string): number {
    return this.sent.filter((item) => item.to === phone).length;
  }

  async sendAuthenticationCode(message: AuthenticationCodeMessage): Promise<WhatsAppSendResult> {
    this.sent.push(message);
    return { messageId: `wamid.fake.${this.sent.length}` };
  }
}

const PASSWORD = "Password@123";
const NEW_PASSWORD = "Changed#456";
const MAX_ATTEMPTS = 5;

const wrongCode = (code: string): string => (code === "000000" ? "111111" : "000000");

/** Header-only PNG: the API reads format and size from the IHDR chunk. */
const png = (width: number, height: number): Buffer => {
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write("IHDR", 12, "ascii");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return Buffer.concat([header, randomBytes(256)]);
};

interface Session {
  accessToken: string;
  refreshToken: string;
  user: { id: string; phone: string; email?: string; profileImage?: string; isPhoneVerified: boolean };
}

describe("Account self-service (e2e)", () => {
  const originalCwd = process.cwd();
  const whatsapp = new FakeWhatsApp();
  let workDir: string;
  let mongo: MongoMemoryServer;
  let app: INestApplication<App>;
  let db: Connection;
  let phoneCounter = 0;

  const api = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const nextPhone = () => `+9196000${String(++phoneCounter).padStart(5, "0")}`;

  const skipCooldown = (phone: string, purpose: string) =>
    db
      .collection("otp_send_quotas")
      .updateOne({ phone, purpose }, { $set: { lastSentAt: new Date(Date.now() - 10 * 60_000) } });

  /** A verified account, signed in. */
  const signUp = async (role: "CUSTOMER" | "DRIVER" = "CUSTOMER", extra: Record<string, unknown> = {}): Promise<Session> => {
    const phone = nextPhone();
    const started = await api()
      .post("/api/v1/auth/register")
      .send({ firstName: "Asha", lastName: "Verma", phone, password: PASSWORD, role, ...extra })
      .expect(202);
    const verified = await api()
      .post("/api/v1/auth/verify-otp")
      .send({ phone, otp: whatsapp.lastCodeFor(phone), verificationId: started.body.data.verificationId, deviceId: "device-1" })
      .expect(200);
    return verified.body.data as Session;
  };

  const forgot = (phone: string) => api().post("/api/v1/auth/password/forgot").send({ phone });
  const verifyReset = (phone: string, otp: string) => api().post("/api/v1/auth/password/verify-otp").send({ phone, otp });
  const reset = (resetToken: string, newPassword: string, deviceId = "device-2") =>
    api().post("/api/v1/auth/password/reset").send({ resetToken, newPassword, deviceId });
  const login = (phone: string, password: string) =>
    api().post("/api/v1/auth/login").send({ phone, password, deviceId: "device-1" });

  /** forgot → code → token, in one step. */
  const resetTokenFor = async (phone: string): Promise<string> => {
    await forgot(phone).expect(200);
    const ticket = await verifyReset(phone, whatsapp.lastCodeFor(phone)).expect(200);
    return ticket.body.data.resetToken as string;
  };

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 60_000 } });
    workDir = await mkdtemp(join(tmpdir(), "tirvona-ride-account-"));
    process.chdir(workDir);
    Object.assign(process.env, {
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      SWAGGER_ENABLED: "false",
      MONGODB_URI: mongo.getUri(),
      MONGODB_DB_NAME: "tirvona_ride_account",
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
      OTP_MAX_SENDS_PER_WINDOW: "10",
      OTP_SEND_WINDOW_MINUTES: "60",
      PASSWORD_RESET_TOKEN_TTL_MINUTES: "10",
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

  // ── Forgot password ────────────────────────────────────────────────────

  describe("forgot password", () => {
    it("resets the password end to end: code → token → new password, every old session ends", async () => {
      const account = await signUp();
      const phone = account.user.phone;
      const secondDevice = (await login(phone, PASSWORD).expect(200)).body.data as Session;

      const challenge = (await forgot(phone).expect(200)).body.data;
      expect(challenge).toMatchObject({ phone, channel: "WHATSAPP", codeLength: 6, codeSent: true });
      expect(challenge).not.toHaveProperty("code");

      const ticket = (await verifyReset(phone, whatsapp.lastCodeFor(phone)).expect(200)).body.data;
      expect(ticket.resetToken).toEqual(expect.any(String));
      expect(ticket.expiresInSeconds).toBe(600);
      // Only a hash of the token is stored.
      const stored = await db.collection("password_resets").findOne({});
      expect(JSON.stringify(stored)).not.toContain(ticket.resetToken);

      const session = (await reset(ticket.resetToken, NEW_PASSWORD).expect(200)).body.data as Session;
      expect(session.accessToken).toEqual(expect.any(String));
      expect(session.user.id).toBe(account.user.id);

      // Old password is gone, the new one works.
      await login(phone, PASSWORD).expect(401);
      await login(phone, NEW_PASSWORD).expect(200);
      // Both earlier devices were signed out; the new session was not.
      await api().post("/api/v1/auth/refresh").send({ refreshToken: account.refreshToken }).expect(401);
      await api().post("/api/v1/auth/refresh").send({ refreshToken: secondDevice.refreshToken }).expect(401);
      await api().post("/api/v1/auth/refresh").send({ refreshToken: session.refreshToken }).expect(200);
      // The token and the code are single use.
      await reset(ticket.resetToken, "Another#789").expect(400, /PASSWORD_RESET_INVALID/);
      expect(await db.collection("password_resets").countDocuments({})).toBe(0);
    });

    it("tells the user when no account uses the number, and never resets admins", async () => {
      await forgot(nextPhone()).expect(404, /ACCOUNT_NOT_FOUND/);

      const adminPhone = nextPhone();
      await db.collection("users").insertOne({
        phone: adminPhone,
        role: "ADMIN",
        status: "ACTIVE",
        firstName: "Admin",
        isPhoneVerified: true,
        isEmailVerified: false,
      });
      await forgot(adminPhone).expect(404, /ACCOUNT_NOT_FOUND/);
      expect(whatsapp.countFor(adminPhone)).toBe(0);
    });

    it("refuses blocked accounts", async () => {
      const account = await signUp();
      await db.collection("users").updateOne({ phone: account.user.phone }, { $set: { status: "BLOCKED" } });
      await forgot(account.user.phone).expect(403, /USER_BLOCKED/);
    });

    it("keeps the code already sent inside the cooldown, and a resend kills the old code", async () => {
      const { user } = await signUp();
      await forgot(user.phone).expect(200);
      const first = whatsapp.lastCodeFor(user.phone);
      const again = (await forgot(user.phone).expect(200)).body.data;
      expect(again.codeSent).toBe(false);
      expect(again.resendAvailableInSeconds).toBeGreaterThan(0);

      await skipCooldown(user.phone, "RESET_PASSWORD");
      expect((await forgot(user.phone).expect(200)).body.data.codeSent).toBe(true);
      const second = whatsapp.lastCodeFor(user.phone);
      if (first !== second) await verifyReset(user.phone, first).expect(400, /OTP_INVALID/);
      await verifyReset(user.phone, second).expect(200);
    });

    it("limits wrong guesses and never accepts a code from another flow", async () => {
      const { user } = await signUp();
      await verifyReset(user.phone, "123456").expect(400, /OTP_NOT_ACTIVE/);
      await forgot(user.phone).expect(200);
      const code = whatsapp.lastCodeFor(user.phone);
      for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++)
        await verifyReset(user.phone, wrongCode(code)).expect(400, /OTP_INVALID/);
      await verifyReset(user.phone, wrongCode(code)).expect(400, /OTP_TOO_MANY_ATTEMPTS/);
      await verifyReset(user.phone, code).expect(400, /OTP_TOO_MANY_ATTEMPTS/);
    });

    it("validates the new password and rejects the current one without spending the token", async () => {
      const { user } = await signUp();
      const token = await resetTokenFor(user.phone);
      await reset(token, "weakpass").expect(400);
      await reset(token, PASSWORD).expect(400, /PASSWORD_UNCHANGED/);
      await reset(token, NEW_PASSWORD).expect(200);
    });

    it("expires unused tokens and refuses a token after the account was blocked", async () => {
      const first = await signUp();
      const expired = await resetTokenFor(first.user.phone);
      await db.collection("password_resets").updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });
      await reset(expired, NEW_PASSWORD).expect(400, /PASSWORD_RESET_INVALID/);

      const second = await signUp();
      const token = await resetTokenFor(second.user.phone);
      await db.collection("users").updateOne({ phone: second.user.phone }, { $set: { status: "BLOCKED" } });
      await reset(token, NEW_PASSWORD).expect(403, /USER_BLOCKED/);
      await reset("x".repeat(43), NEW_PASSWORD).expect(400, /PASSWORD_RESET_INVALID/);
    });

    it("a newer verification replaces the older token", async () => {
      const { user } = await signUp();
      const older = await resetTokenFor(user.phone);
      await skipCooldown(user.phone, "RESET_PASSWORD");
      const newer = await resetTokenFor(user.phone);
      await reset(older, NEW_PASSWORD).expect(400, /PASSWORD_RESET_INVALID/);
      await reset(newer, NEW_PASSWORD).expect(200);
    });
  });

  // ── Sessions ───────────────────────────────────────────────────────────

  describe("sign out everywhere", () => {
    it("ends every refresh session of the user only", async () => {
      const account = await signUp();
      const other = await signUp();
      const second = (await login(account.user.phone, PASSWORD).expect(200)).body.data as Session;

      const result = (await api().post("/api/v1/auth/logout-all").set(bearer(account.accessToken)).expect(200)).body.data;
      expect(result.sessionsEnded).toBe(2);
      await api().post("/api/v1/auth/refresh").send({ refreshToken: account.refreshToken }).expect(401);
      await api().post("/api/v1/auth/refresh").send({ refreshToken: second.refreshToken }).expect(401);
      await api().post("/api/v1/auth/refresh").send({ refreshToken: other.refreshToken }).expect(200);
      await api().post("/api/v1/auth/logout-all").expect(401);
    });
  });

  // ── Profile ────────────────────────────────────────────────────────────

  describe("profile", () => {
    it("edits name and email; a new email is unverified and must be unique; null removes it", async () => {
      const account = await signUp();
      const taken = await signUp("CUSTOMER", { email: "taken@example.com" });
      expect(taken.user.email).toBe("taken@example.com");

      const updated = (
        await api()
          .patch("/api/v1/users/me")
          .set(bearer(account.accessToken))
          .send({ firstName: "  Radha ", lastName: "Sharma", email: " Radha@Example.com " })
          .expect(200)
      ).body.data;
      expect(updated).toMatchObject({ firstName: "Radha", lastName: "Sharma", email: "radha@example.com", isEmailVerified: false });

      await api().patch("/api/v1/users/me").set(bearer(account.accessToken)).send({ email: "TAKEN@example.com" }).expect(409, /EMAIL_ALREADY_REGISTERED/);
      await api().patch("/api/v1/users/me").set(bearer(account.accessToken)).send({ email: "not-an-email" }).expect(400);
      await api().patch("/api/v1/users/me").set(bearer(account.accessToken)).send({ firstName: "" }).expect(400);

      // Gender and date of birth; an impossible date is refused.
      const details = (
        await api().patch("/api/v1/users/me").set(bearer(account.accessToken)).send({ gender: "female", dob: "1994-08-15" }).expect(200)
      ).body.data;
      expect(details.gender).toBe("female");
      expect(details.dob).toBe("1994-08-15T00:00:00.000Z");
      const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
      await api().patch("/api/v1/users/me").set(bearer(account.accessToken)).send({ dob: tomorrow }).expect(400);
      await api().patch("/api/v1/users/me").set(bearer(account.accessToken)).send({ dob: "1850-01-01" }).expect(400);
      await api().patch("/api/v1/users/me").set(bearer(account.accessToken)).send({ gender: "robot" }).expect(400);

      // An empty last name removes it.
      const noLastName = (await api().patch("/api/v1/users/me").set(bearer(account.accessToken)).send({ lastName: "" }).expect(200)).body.data;
      expect(noLastName.lastName).toBeUndefined();

      const cleared = (await api().patch("/api/v1/users/me").set(bearer(account.accessToken)).send({ email: null }).expect(200)).body.data;
      expect(cleared.email).toBeUndefined();
      const me = (await api().get("/api/v1/auth/me").set(bearer(account.accessToken)).expect(200)).body.data;
      expect(me).toMatchObject({ firstName: "Radha", gender: "female" });
      expect(me.email).toBeUndefined();
    });

    it("changes the password with the current one", async () => {
      const account = await signUp();
      const change = (body: Record<string, string>) =>
        api().patch("/api/v1/users/me/password").set(bearer(account.accessToken)).send(body);
      await change({ currentPassword: "Wrong@123", newPassword: NEW_PASSWORD }).expect(400, /AUTH_INVALID_CREDENTIALS/);
      await change({ currentPassword: PASSWORD, newPassword: PASSWORD }).expect(400, /PASSWORD_UNCHANGED/);
      await change({ currentPassword: PASSWORD, newPassword: "short" }).expect(400);
      await change({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }).expect(200);
      await login(account.user.phone, NEW_PASSWORD).expect(200);
      await login(account.user.phone, PASSWORD).expect(401);
    });
  });

  // ── Profile photo ──────────────────────────────────────────────────────

  describe("profile photo", () => {
    it("uploads, serves (private, versioned, 304), replaces and removes the photo", async () => {
      const account = await signUp("DRIVER");
      const auth = bearer(account.accessToken);
      await api().get("/api/v1/users/me/profile-image").set(auth).expect(404, /PROFILE_IMAGE_NOT_SET/);

      const photo = png(512, 512);
      const uploaded = (
        await api().post("/api/v1/users/profile-image").set(auth).attach("file", photo, "me.png").expect(200)
      ).body.data;
      expect(uploaded.profileImage).toMatch(/^\/users\/me\/profile-image\?v=[0-9a-f]{16}$/);
      expect((await api().get("/api/v1/auth/me").set(auth).expect(200)).body.data.profileImage).toBe(uploaded.profileImage);

      const served = await api().get(`/api/v1${uploaded.profileImage}`).set(auth).buffer(true).expect(200);
      expect(served.headers["content-type"]).toBe("image/png");
      expect(served.headers["cache-control"]).toContain("private");
      expect(Buffer.compare(served.body as Buffer, photo)).toBe(0);
      await api()
        .get("/api/v1/users/me/profile-image")
        .set({ ...auth, "If-None-Match": served.headers.etag })
        .expect(304);
      await api().get("/api/v1/users/me/profile-image").expect(401);

      // Another user never gets this photo.
      const other = await signUp();
      await api().get("/api/v1/users/me/profile-image").set(bearer(other.accessToken)).expect(404);

      const replaced = (
        await api().post("/api/v1/users/profile-image").set(auth).attach("file", png(800, 600), "new.png").expect(200)
      ).body.data;
      expect(replaced.profileImage).not.toBe(uploaded.profileImage);
      expect(await db.collection("profile_images").countDocuments({})).toBe(1);

      const removed = (await api().delete("/api/v1/users/profile-image").set(auth).expect(200)).body.data;
      expect(removed.profileImage).toBeUndefined();
      await api().get("/api/v1/users/me/profile-image").set(auth).expect(404);
    });

    it("rejects files that are not usable photos, whatever they claim to be", async () => {
      const { accessToken } = await signUp();
      const upload = (data: Buffer, name: string) =>
        api().post("/api/v1/users/profile-image").set(bearer(accessToken)).attach("file", data, name);
      await upload(Buffer.from("definitely not an image"), "fake.png").expect(400, /PROFILE_IMAGE_INVALID/);
      await upload(png(64, 64), "tiny.png").expect(400, /at least 128/);
      await upload(png(2000, 300), "banner.png").expect(400, /too narrow or too wide/);
      await api().post("/api/v1/users/profile-image").set(bearer(accessToken)).expect(400, /PROFILE_IMAGE_INVALID/);
    });
  });

  // ── Saved places: the rider's own ─────────────────────────────────────

  describe("other saved places", () => {
    const gym = { label: "Gym", address: "Cult Fit, Sector 18, Noida", latitude: 28.5701, longitude: 77.3219 };

    it("adds, lists, renames, moves and removes labelled places next to Home and Work", async () => {
      const { accessToken } = await signUp();
      const auth = bearer(accessToken);

      await api().put("/api/v1/places/saved/home").set(auth).send({ address: "Sector 50, Noida", latitude: 28.5706, longitude: 77.3677 }).expect(200);
      const added = (await api().post("/api/v1/places/saved/others").set(auth).send(gym).expect(201)).body.data;
      expect(added.home).toMatchObject({ kind: "home", label: null });
      expect(added.others).toHaveLength(1);
      expect(added.others[0]).toMatchObject({ kind: "other", label: "Gym", address: gym.address, name: null, id: expect.any(String) });
      expect(added.othersRemaining).toBe(19);

      const second = (
        await api()
          .post("/api/v1/places/saved/others")
          .set(auth)
          .send({ label: "Mom's house", name: "Gaur City", address: "Gaur City 2, Greater Noida West", latitude: 28.6139, longitude: 77.4255 })
          .expect(201)
      ).body.data;
      expect(second.others.map((place: { label: string }) => place.label)).toEqual(["Gym", "Mom's house"]);

      const id = added.others[0].id as string;
      const renamed = (await api().patch(`/api/v1/places/saved/others/${id}`).set(auth).send({ label: "Morning gym" }).expect(200)).body.data;
      expect(renamed.others[0]).toMatchObject({ label: "Morning gym", address: gym.address });

      const moved = (
        await api()
          .patch(`/api/v1/places/saved/others/${id}`)
          .set(auth)
          .send({ address: "Anytime Fitness, Sector 62, Noida", latitude: 28.6273, longitude: 77.3725 })
          .expect(200)
      ).body.data;
      expect(moved.others[0]).toMatchObject({ label: "Morning gym", address: "Anytime Fitness, Sector 62, Noida", latitude: 28.6273 });
      // A move must send the whole point.
      await api().patch(`/api/v1/places/saved/others/${id}`).set(auth).send({ latitude: 28.1 }).expect(400);

      const removed = (await api().delete(`/api/v1/places/saved/others/${id}`).set(auth).expect(200)).body.data;
      expect(removed.others.map((place: { label: string }) => place.label)).toEqual(["Mom's house"]);
      expect(removed.home).not.toBeNull();
      await api().delete(`/api/v1/places/saved/others/${id}`).set(auth).expect(404, /SAVED_PLACE_NOT_FOUND/);
    });

    it("keeps labels unique per rider (case-insensitive) and reserves Home and Work", async () => {
      const { accessToken } = await signUp();
      const other = await signUp();
      const auth = bearer(accessToken);
      await api().post("/api/v1/places/saved/others").set(auth).send(gym).expect(201);
      await api().post("/api/v1/places/saved/others").set(auth).send({ ...gym, label: " gym " }).expect(409, /SAVED_PLACE_DUPLICATE_LABEL/);
      await api().post("/api/v1/places/saved/others").set(auth).send({ ...gym, label: "HOME" }).expect(400, /SAVED_PLACE_DUPLICATE_LABEL/);
      // Another rider may use the same label.
      await api().post("/api/v1/places/saved/others").set(bearer(other.accessToken)).send(gym).expect(201);

      const second = (await api().post("/api/v1/places/saved/others").set(auth).send({ ...gym, label: "Pool" }).expect(201)).body.data;
      const poolId = second.others[1].id as string;
      await api().patch(`/api/v1/places/saved/others/${poolId}`).set(auth).send({ label: "GYM" }).expect(409, /SAVED_PLACE_DUPLICATE_LABEL/);
    });

    it("is private to the rider, validated, capped, and never reachable through the Home/Work routes", async () => {
      const owner = await signUp();
      const stranger = await signUp();
      const auth = bearer(owner.accessToken);
      const id = (await api().post("/api/v1/places/saved/others").set(auth).send(gym).expect(201)).body.data.others[0].id;

      await api().patch(`/api/v1/places/saved/others/${id}`).set(bearer(stranger.accessToken)).send({ label: "Mine" }).expect(404);
      await api().delete(`/api/v1/places/saved/others/${id}`).set(bearer(stranger.accessToken)).expect(404);
      await api().delete("/api/v1/places/saved/others/not-an-id").set(auth).expect(404);
      await api().put("/api/v1/places/saved/other").set(auth).send(gym).expect(400);
      await api().post("/api/v1/places/saved/others").set(auth).send({ ...gym, label: "" }).expect(400);
      await api().post("/api/v1/places/saved/others").set(auth).send({ ...gym, label: "x".repeat(41) }).expect(400);
      await api().post("/api/v1/places/saved/others").set(auth).send({ ...gym, latitude: 91, label: "Bad" }).expect(400);

      for (let index = 2; index <= 20; index++)
        await api().post("/api/v1/places/saved/others").set(auth).send({ ...gym, label: `Place ${index}` }).expect(201);
      const full = (await api().get("/api/v1/places/saved").set(auth).expect(200)).body.data;
      expect(full.others).toHaveLength(20);
      expect(full.othersRemaining).toBe(0);
      await api().post("/api/v1/places/saved/others").set(auth).send({ ...gym, label: "One more" }).expect(400, /SAVED_PLACE_LIMIT_REACHED/);
    });

    it("migrates the old one-per-kind index and backfills Home/Work slots", async () => {
      const { SavedPlacesService } = await import("../src/modules/places/saved-places.service");
      const collection = db.collection("saved_places");
      const { user } = await signUp();
      const { Types } = await import("mongoose");
      const userId = new Types.ObjectId(user.id);

      // A database from before "other" places: only Home/Work rows, the old index.
      await collection.deleteMany({});
      await collection.dropIndexes();
      await collection.createIndex({ userId: 1, kind: 1 }, { unique: true, name: "userId_1_kind_1" });
      await collection.insertOne({ userId, kind: "work", address: "Old office", latitude: 28.5, longitude: 77.3 });

      await app.get(SavedPlacesService).onModuleInit();

      const names = (await collection.indexes()).map((index) => index.name);
      expect(names).not.toContain("userId_1_kind_1");
      expect(await collection.findOne({ userId, kind: "work" })).toMatchObject({ slot: "work" });
      // Work is still one-per-rider after the migration.
      await expect(
        collection.insertOne({ userId, kind: "work", slot: "work", address: "Second office", latitude: 28.5, longitude: 77.3 }),
      ).rejects.toMatchObject({ code: 11000 });
    });
  });
});
