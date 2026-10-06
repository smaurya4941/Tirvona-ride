import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { getConnectionToken } from "@nestjs/mongoose";
import { Test } from "@nestjs/testing";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Types } from "mongoose";
import type { Connection } from "mongoose";
import request from "supertest";
import type { App } from "supertest/types";
import { WhatsAppGateway } from "../src/modules/whatsapp/whatsapp.gateway";
import type {
  AuthenticationCodeMessage,
  WhatsAppSendResult,
} from "../src/modules/whatsapp/whatsapp.gateway";

/**
 * Account deletion (docs/account-deletion/README.md) and the public legal
 * pages Google Play links to.
 */

class FakeWhatsApp extends WhatsAppGateway {
  readonly provider = "fake";
  readonly sent: AuthenticationCodeMessage[] = [];

  lastCodeFor(phone: string): string {
    const message = [...this.sent].reverse().find((item) => item.to === phone);
    if (!message) throw new Error(`no code sent to ${phone}`);
    return message.code;
  }

  async sendAuthenticationCode(
    message: AuthenticationCodeMessage,
  ): Promise<WhatsAppSendResult> {
    this.sent.push(message);
    return { messageId: `wamid.fake.${this.sent.length}` };
  }
}

const PASSWORD = "Password@123";

interface Session {
  accessToken: string;
  refreshToken: string;
  user: { id: string; phone: string };
}

describe("Account deletion and legal pages (e2e)", () => {
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
  const oid = (id: string) => new Types.ObjectId(id);

  const signUp = async (
    role: "CUSTOMER" | "DRIVER" = "CUSTOMER",
    phone = nextPhone(),
  ): Promise<Session> => {
    const started = await api()
      .post("/api/v1/auth/register")
      .send({
        firstName: "Asha",
        lastName: "Verma",
        email: `${phone.slice(1)}@example.com`,
        phone,
        password: PASSWORD,
        role,
      })
      .expect(202);
    const verified = await api()
      .post("/api/v1/auth/verify-otp")
      .send({
        phone,
        otp: whatsapp.lastCodeFor(phone),
        verificationId: started.body.data.verificationId,
        deviceId: "device-1",
      })
      .expect(200);
    return verified.body.data as Session;
  };

  const deleteAccount = (token: string, password: string) =>
    api()
      .post("/api/v1/users/me/delete-account")
      .set(bearer(token))
      .send({ password });

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create({
      instance: { launchTimeout: 60_000 },
    });
    workDir = await mkdtemp(join(tmpdir(), "tirvona-ride-deletion-"));
    process.chdir(workDir);
    Object.assign(process.env, {
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      SWAGGER_ENABLED: "false",
      MONGODB_URI: mongo.getUri(),
      MONGODB_DB_NAME: "tirvona_ride_deletion",
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
      OTP_MAX_SENDS_PER_WINDOW: "50",
      LEGAL_ENTITY_NAME: "Tirvona Test Pvt Ltd",
      SUPPORT_EMAIL: "help@tirvona.test",
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

  describe("customer", () => {
    it("refuses a wrong password and leaves the account untouched", async () => {
      const account = await signUp();
      const response = await deleteAccount(
        account.accessToken,
        "Wrong#Pass1",
      ).expect(400);
      expect(response.body.code ?? response.body.error?.code).toBe(
        "ACCOUNT_DELETION_PASSWORD_INVALID",
      );
      await api()
        .get("/api/v1/users/me")
        .set(bearer(account.accessToken))
        .expect(200);
    });

    it("requires a password in the body", async () => {
      const account = await signUp();
      await api()
        .post("/api/v1/users/me/delete-account")
        .set(bearer(account.accessToken))
        .send({})
        .expect(400);
      await api()
        .post("/api/v1/users/me/delete-account")
        .send({ password: PASSWORD })
        .expect(401);
    });

    it("erases personal data, ends every session and frees the number", async () => {
      const account = await signUp();
      const userId = oid(account.user.id);
      const second = (
        await api()
          .post("/api/v1/auth/login")
          .send({
            phone: account.user.phone,
            password: PASSWORD,
            deviceId: "device-2",
          })
          .expect(200)
      ).body.data as Session;

      await db
        .collection("saved_places")
        .insertOne({ userId, kind: "HOME", label: "Home", slot: "HOME" });
      await db
        .collection("emergency_contacts")
        .insertOne({ userId, name: "Mum", phone: "+919800000001" });
      await db
        .collection("notifications")
        .insertOne({ userId, title: "Hello" });
      await db
        .collection("device_tokens")
        .insertOne({ userId, token: "fcm-token", isActive: true });
      await db
        .collection("profile_images")
        .insertOne({ userId, data: Buffer.from("x") });
      const rideId = new Types.ObjectId();
      await db
        .collection("rides")
        .insertOne({
          _id: rideId,
          rideCode: "TRDEL00001",
          customerId: userId,
          isActive: false,
          status: "COMPLETED",
        });
      await db
        .collection("ride_share_tokens")
        .insertOne({
          rideId,
          customerId: userId,
          isActive: true,
          expiresAt: new Date(Date.now() + 3600_000),
        });

      const response = await deleteAccount(
        account.accessToken,
        PASSWORD,
      ).expect(200);
      expect(response.body.data).toEqual({ deleted: true });

      const user = await db.collection("users").findOne({ _id: userId });
      expect(user).toMatchObject({
        status: "DELETED",
        firstName: "Deleted user",
        isPhoneVerified: false,
      });
      expect(user?.phone).toBe(`deleted:${account.user.id}`);
      for (const field of [
        "email",
        "lastName",
        "passwordHash",
        "profileImage",
        "dob",
        "gender",
        "lastLoginAt",
      ])
        expect(user).not.toHaveProperty(field);
      expect(user?.deletedAt).toBeInstanceOf(Date);

      for (const collection of [
        "saved_places",
        "emergency_contacts",
        "notifications",
        "device_tokens",
        "profile_images",
      ])
        expect(await db.collection(collection).countDocuments({ userId })).toBe(
          0,
        );
      expect(
        await db
          .collection("user_sessions")
          .countDocuments({ userId, isActive: true }),
      ).toBe(0);
      // Ride history stays (without personal data on the user).
      expect(
        await db.collection("rides").countDocuments({ customerId: userId }),
      ).toBe(1);
      expect(
        await db
          .collection("ride_share_tokens")
          .countDocuments({ customerId: userId, isActive: true }),
      ).toBe(0);

      // Tokens die at once, sign-in and refresh are refused.
      await api()
        .get("/api/v1/users/me")
        .set(bearer(account.accessToken))
        .expect(403);
      await api()
        .get("/api/v1/users/me")
        .set(bearer(second.accessToken))
        .expect(403);
      await api()
        .post("/api/v1/auth/refresh")
        .send({ refreshToken: second.refreshToken })
        .expect(401);
      await api()
        .post("/api/v1/auth/login")
        .send({ phone: account.user.phone, password: PASSWORD, deviceId: "d" })
        .expect(401);

      // The same number can open a brand-new account.
      const again = await signUp("CUSTOMER", account.user.phone);
      expect(again.user.id).not.toBe(account.user.id);
    });

    it("is blocked while a ride is in progress, then works once it ends", async () => {
      const account = await signUp();
      const userId = oid(account.user.id);
      const rideId = new Types.ObjectId();
      await db
        .collection("rides")
        .insertOne({
          _id: rideId,
          rideCode: "TRDEL00002",
          customerId: userId,
          isActive: true,
          status: "STARTED",
        });

      const blocked = await deleteAccount(account.accessToken, PASSWORD).expect(
        409,
      );
      expect(blocked.body.code ?? blocked.body.error?.code).toBe(
        "ACCOUNT_DELETION_BLOCKED",
      );
      expect(
        await db
          .collection("users")
          .countDocuments({ _id: userId, status: "ACTIVE" }),
      ).toBe(1);

      await db
        .collection("rides")
        .updateOne(
          { _id: rideId },
          { $set: { isActive: false, status: "COMPLETED" } },
        );
      await deleteAccount(account.accessToken, PASSWORD).expect(200);
    });

    it("is blocked by an unpaid cancellation fee", async () => {
      const account = await signUp();
      const userId = oid(account.user.id);
      await db
        .collection("cancellations")
        .insertOne({ customerId: userId, feeStatus: "DUE", feeAmount: 30 });
      await deleteAccount(account.accessToken, PASSWORD).expect(409);
      await db
        .collection("cancellations")
        .updateOne({ customerId: userId }, { $set: { feeStatus: "WAIVED" } });
      await deleteAccount(account.accessToken, PASSWORD).expect(200);
    });
  });

  describe("driver", () => {
    it("erases licence details, documents and vehicle details; blocks unsettled earnings", async () => {
      const account = await signUp("DRIVER");
      const userId = oid(account.user.id);
      const driverId = new Types.ObjectId();
      const vehicleId = new Types.ObjectId();
      await db.collection("driver_profiles").deleteMany({ userId }); // signup already created a bare profile
      await db.collection("driver_profiles").insertOne({
        _id: driverId,
        userId,
        driverCode: "DRV-DEL-1",
        driverStatus: "APPROVED",
        licenseNumber: "DL-1234567890",
        dateOfBirth: new Date("1990-01-01"),
        address: "Somewhere",
        isOnline: true,
        isAvailable: true,
      });
      await db
        .collection("driver_documents")
        .insertOne({
          driverId,
          documentType: "LICENSE",
          filePath: "/nonexistent/licence.jpg",
        });
      await db.collection("vehicles").insertOne({
        _id: vehicleId,
        driverId,
        registrationNumber: "UP16AB1234",
        make: "Toyota",
        vehicleModel: "Etios",
        color: "White",
        isActive: true,
      });
      await db
        .collection("vehicle_documents")
        .insertOne({
          vehicleId,
          documentType: "RC",
          filePath: "/nonexistent/rc.jpg",
        });
      await db
        .collection("driver_earnings")
        .insertOne({
          driverUserId: userId,
          driverId,
          status: "AVAILABLE",
          netEarningPaise: 5000,
        });

      const blocked = await deleteAccount(account.accessToken, PASSWORD).expect(
        409,
      );
      expect(
        blocked.body.data?.reason ?? blocked.body.error?.data?.reason,
      ).toBe("EARNINGS_UNSETTLED");

      await db
        .collection("driver_earnings")
        .updateOne({ driverUserId: userId }, { $set: { status: "PAID" } });
      await deleteAccount(account.accessToken, PASSWORD).expect(200);

      const profile = await db
        .collection("driver_profiles")
        .findOne({ _id: driverId });
      expect(profile).toMatchObject({
        driverStatus: "SUSPENDED",
        isOnline: false,
        isAvailable: false,
      });
      for (const field of ["licenseNumber", "dateOfBirth", "address"])
        expect(profile).not.toHaveProperty(field);
      expect(
        await db.collection("driver_documents").countDocuments({ driverId }),
      ).toBe(0);
      expect(
        await db.collection("vehicle_documents").countDocuments({ vehicleId }),
      ).toBe(0);
      const vehicle = await db
        .collection("vehicles")
        .findOne({ _id: vehicleId });
      expect(vehicle).toMatchObject({
        isActive: false,
        registrationNumber: `DELETED-${vehicleId.toHexString().toUpperCase()}`,
      });
      for (const field of ["make", "vehicleModel", "color"])
        expect(vehicle).not.toHaveProperty(field);
      // The earnings ledger is kept.
      expect(
        await db
          .collection("driver_earnings")
          .countDocuments({ driverUserId: userId }),
      ).toBe(1);
    });
  });

  describe("legal pages", () => {
    it.each([
      ["privacy", "Privacy policy"],
      ["terms", "Terms of use"],
      ["delete-account", "Delete your Tirvona Rides account"],
    ])("serves /legal/%s publicly as HTML", async (path, heading) => {
      const response = await api().get(`/api/v1/legal/${path}`).expect(200);
      expect(response.headers["content-type"]).toContain("text/html");
      expect(response.text).toContain(heading);
      expect(response.text).toContain("help@tirvona.test");
      expect(response.text).toContain("Tirvona Test Pvt Ltd");
    });
  });
});
