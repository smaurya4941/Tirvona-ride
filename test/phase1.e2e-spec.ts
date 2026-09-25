import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Logger } from "@nestjs/common";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import type { App } from "supertest/types";

/**
 * Phase 1 "done" tests (spec §41, A–E) against the real HTTP surface.
 * Hermetic: in-memory MongoDB, Redis disabled, uploads written under a
 * throwaway working directory, and no dependency on the developer's .env.
 */

const PASSWORD = "Password@123";
// 1×1 transparent PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const LICENSE_EXPIRY = new Date(Date.UTC(new Date().getUTCFullYear() + 5, 0, 1)).toISOString();

const PHONES = {
  customer: "+919800000001",
  driverA: "+919800000002",
  driverB: "+919800000003",
  admin: "+919800000009",
};

describe("Phase 1 — done tests (e2e)", () => {
  const originalCwd = process.cwd();
  const otps = new Map<string, string>();
  let workDir: string;
  let mongo: MongoMemoryServer;
  let app: INestApplication<App>;

  const api = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function registerAndVerify(
    role: "CUSTOMER" | "DRIVER",
    phone: string,
    firstName: string,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const registered = await api()
      .post("/api/v1/auth/register")
      .send({ firstName, lastName: "Test", phone, password: PASSWORD, role })
      .expect(201);
    await api().post("/api/v1/auth/send-otp").send({ phone }).expect(200);
    await api()
      .post("/api/v1/auth/verify-otp")
      .send({ phone, otp: otps.get(phone) })
      .expect(200);
    return registered.body.data;
  }

  async function login(phone: string): Promise<{ accessToken: string; refreshToken: string; user: Record<string, unknown> }> {
    const response = await api()
      .post("/api/v1/auth/login")
      .send({ phone, password: PASSWORD })
      .expect(200);
    return response.body.data;
  }

  async function me(token: string) {
    return (await api().get("/api/v1/auth/me").set(bearer(token)).expect(200)).body.data;
  }

  async function completeOnboarding(token: string, registrationNumber: string) {
    await api()
      .patch("/api/v1/drivers/me")
      .set(bearer(token))
      .send({ licenseNumber: `DL${registrationNumber}`, licenseExpiry: LICENSE_EXPIRY, address: "Vrindavan, UP" })
      .expect(200);
    const vehicle = await api()
      .post("/api/v1/vehicles")
      .set(bearer(token))
      .send({ vehicleType: "BIKE", registrationNumber, make: "Honda", model: "Shine", color: "Black" })
      .expect(201);
    const documents: Record<string, string> = {};
    for (const documentType of ["DRIVING_LICENSE", "AADHAAR", "PROFILE_PHOTO"]) {
      const uploaded = await api()
        .post("/api/v1/drivers/me/documents")
        .set(bearer(token))
        .field("documentType", documentType)
        .attach("file", PNG, { filename: `${documentType.toLowerCase()}.png`, contentType: "image/png" })
        .expect(201);
      documents[documentType] = uploaded.body.data.id;
    }
    return { vehicleId: vehicle.body.data.id as string, documents };
  }

  beforeAll(async () => {
    // Capture dev OTPs from OtpService's log line: "[DEV OTP] <phone> (...) → 123456".
    jest.spyOn(Logger.prototype, "log").mockImplementation((message: unknown) => {
      const match = /\[DEV OTP\] (\+\d+) \(.*\) → (\d{6})/.exec(String(message));
      if (match) otps.set(match[1], match[2]);
    });

    mongo = await MongoMemoryServer.create();
    workDir = await mkdtemp(join(tmpdir(), "tirvona-ride-e2e-"));
    process.chdir(workDir);
    Object.assign(process.env, {
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      SWAGGER_ENABLED: "false",
      MONGODB_URI: mongo.getUri(),
      MONGODB_DB_NAME: "tirvona_ride_phase1",
      REDIS_URL: "",
      THROTTLE_LIMIT: "1000",
      JWT_ACCESS_SECRET: randomBytes(48).toString("base64url"),
      JWT_REFRESH_SECRET: randomBytes(48).toString("base64url"),
    });

    // Imported after chdir so UPLOAD_ROOT resolves inside workDir.
    const { AppModule } = await import("../src/app.module");
    const { configureApp } = await import("../src/app.setup");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    configureApp(app);
    await app.init();

    const { UsersService } = await import("../src/modules/users/users.service");
    const { UserRole } = await import("../src/common/types/user-role.enum");
    await app.get(UsersService).create({
      phone: PHONES.admin,
      password: PASSWORD,
      role: UserRole.ADMIN,
      firstName: "Ops",
    });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
    process.chdir(originalCwd);
    if (workDir) await rm(workDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  // Shared across the ordered scenario below.
  let customerTokens: { accessToken: string; refreshToken: string };
  let driverAToken: string;
  let driverBToken: string;
  let adminToken: string;
  let driverAProfileId: string;
  let driverAVehicleId: string;
  let driverADocumentId: string;

  describe("Test A — customer", () => {
    it("registers, verifies OTP, logs in and resolves to CUSTOMER", async () => {
      await registerAndVerify("CUSTOMER", PHONES.customer, "Sachin");
      customerTokens = await login(PHONES.customer);
      expect(customerTokens.accessToken).toEqual(expect.any(String));
      expect(customerTokens.refreshToken).toEqual(expect.any(String));

      const user = await me(customerTokens.accessToken);
      expect(user).toMatchObject({ role: "CUSTOMER", status: "ACTIVE", isPhoneVerified: true });
      expect(user.driver).toBeUndefined();
      expect(user.passwordHash).toBeUndefined();
    });

    it("rejects self-registration as ADMIN (§14)", async () => {
      await api()
        .post("/api/v1/auth/register")
        .send({ firstName: "Eve", phone: "+919800000099", password: PASSWORD, role: "ADMIN" })
        .expect(400);
    });

    it("rejects a duplicate phone with USER_ALREADY_EXISTS", async () => {
      const response = await api()
        .post("/api/v1/auth/register")
        .send({ firstName: "Dup", phone: PHONES.customer, password: PASSWORD, role: "CUSTOMER" })
        .expect(409);
      expect(response.body).toMatchObject({ success: false, code: "USER_ALREADY_EXISTS" });
    });

    it("answers a wrong password with the generic AUTH_INVALID_CREDENTIALS", async () => {
      const wrongPassword = await api()
        .post("/api/v1/auth/login")
        .send({ phone: PHONES.customer, password: "Wrong@1234" })
        .expect(401);
      const unknownPhone = await api()
        .post("/api/v1/auth/login")
        .send({ phone: "+919811111111", password: PASSWORD })
        .expect(401);
      expect(wrongPassword.body.code).toBe("AUTH_INVALID_CREDENTIALS");
      expect(unknownPhone.body.message).toBe(wrongPassword.body.message);
    });

    it("rejects an incorrect OTP", async () => {
      await api().post("/api/v1/auth/send-otp").send({ phone: "+919822222222" }).expect(200);
      const response = await api()
        .post("/api/v1/auth/verify-otp")
        .send({ phone: "+919822222222", otp: otps.get("+919822222222") === "000000" ? "111111" : "000000" })
        .expect(400);
      expect(response.body.code).toBe("OTP_INVALID");
    });
  });

  describe("Test B — driver onboarding", () => {
    it("starts PENDING and cannot submit incomplete KYC", async () => {
      await registerAndVerify("DRIVER", PHONES.driverA, "Rahul");
      driverAToken = (await login(PHONES.driverA)).accessToken;
      expect((await me(driverAToken)).driver).toEqual({ driverStatus: "PENDING" });

      const profile = await api().get("/api/v1/drivers/me").set(bearer(driverAToken)).expect(200);
      driverAProfileId = profile.body.data.id;
      expect(profile.body.data).toMatchObject({
        driverStatus: "PENDING",
        isOnline: false,
        isAvailable: false,
        ratingAverage: 0,
        totalRides: 0,
      });

      const early = await api().post("/api/v1/drivers/me/submit-kyc").set(bearer(driverAToken)).expect(400);
      expect(early.body).toMatchObject({
        code: "DRIVER_KYC_INCOMPLETE",
        data: { missingLicense: true, missingVehicle: true },
      });
    });

    it("rejects non-document uploads and cleans up rejected temp files", async () => {
      const wrongType = await api()
        .post("/api/v1/drivers/me/documents")
        .set(bearer(driverAToken))
        .field("documentType", "PAN")
        .attach("file", Buffer.from("#!/bin/sh"), { filename: "run.sh", contentType: "text/x-shellscript" })
        .expect(400);
      expect(wrongType.body.code).toBe("DOCUMENT_INVALID_TYPE");

      // Valid file, invalid DTO: multer has already written it to tmp.
      await api()
        .post("/api/v1/drivers/me/documents")
        .set(bearer(driverAToken))
        .field("documentType", "PASSPORT")
        .attach("file", PNG, { filename: "passport.png", contentType: "image/png" })
        .expect(400);
      const leftovers = await readdir(join(workDir, "uploads", "tmp")).catch(() => []);
      expect(leftovers).toEqual([]);
    });

    it("completes profile, vehicle and documents, then submits → UNDER_REVIEW", async () => {
      const { vehicleId, documents } = await completeOnboarding(driverAToken, "UP32AB1234");
      driverAVehicleId = vehicleId;
      driverADocumentId = documents.DRIVING_LICENSE;

      // Files land in uploads/drivers/{driverProfileId}/ (spec §6).
      const stored = await readdir(join(workDir, "uploads", "drivers", driverAProfileId));
      expect(stored).toHaveLength(3);

      // Regression: string ids must be cast to ObjectId in reference filters.
      const own = await api().get(`/api/v1/vehicles/${driverAVehicleId}`).set(bearer(driverAToken)).expect(200);
      expect(own.body.data).toMatchObject({ registrationNumber: "UP32AB1234", model: "Shine", isActive: true });
      const mine = await api().get("/api/v1/vehicles/my").set(bearer(driverAToken)).expect(200);
      expect(mine.body.data).toHaveLength(1);

      const submitted = await api().post("/api/v1/drivers/me/submit-kyc").set(bearer(driverAToken)).expect(200);
      expect(submitted.body.data.driverStatus).toBe("UNDER_REVIEW");
      expect((await me(driverAToken)).driver.driverStatus).toBe("UNDER_REVIEW");
    });

    it("locks the application while under review", async () => {
      const again = await api().post("/api/v1/drivers/me/submit-kyc").set(bearer(driverAToken)).expect(409);
      expect(again.body.code).toBe("DRIVER_ALREADY_SUBMITTED");

      const upload = await api()
        .post("/api/v1/drivers/me/documents")
        .set(bearer(driverAToken))
        .field("documentType", "PAN")
        .attach("file", PNG, { filename: "pan.png", contentType: "image/png" })
        .expect(400);
      expect(upload.body.code).toBe("INVALID_DRIVER_STATUS");

      await api()
        .patch(`/api/v1/vehicles/${driverAVehicleId}`)
        .set(bearer(driverAToken))
        .send({ registrationNumber: "UP32ZZ9999" })
        .expect(400);
    });

    it("refuses a registration number that is already taken", async () => {
      await registerAndVerify("DRIVER", PHONES.driverB, "Amit");
      driverBToken = (await login(PHONES.driverB)).accessToken;
      const duplicate = await api()
        .post("/api/v1/vehicles")
        .set(bearer(driverBToken))
        .send({ vehicleType: "AUTO", registrationNumber: "up32ab1234" })
        .expect(409);
      expect(duplicate.body.code).toBe("VEHICLE_ALREADY_EXISTS");
    });
  });

  describe("Test C — admin review", () => {
    it("lists the driver under review and shows full KYC detail", async () => {
      adminToken = (await login(PHONES.admin)).accessToken;

      const dashboard = await api().get("/api/v1/admin/dashboard").set(bearer(adminToken)).expect(200);
      expect(dashboard.body.data).toMatchObject({ underReviewDrivers: 1, pendingDrivers: 1, approvedDrivers: 0 });

      const list = await api()
        .get("/api/v1/admin/drivers")
        .query({ status: "UNDER_REVIEW" })
        .set(bearer(adminToken))
        .expect(200);
      expect(list.body.data).toHaveLength(1);
      expect(list.body.data[0]).toMatchObject({
        driver: { id: driverAProfileId, driverStatus: "UNDER_REVIEW" },
        user: { phone: PHONES.driverA, firstName: "Rahul" },
      });

      const detail = await api().get(`/api/v1/admin/drivers/${driverAProfileId}`).set(bearer(adminToken)).expect(200);
      expect(detail.body.data.documents).toHaveLength(3);
      expect(detail.body.data.vehicles).toHaveLength(1);
      expect(detail.body.data.vehicles[0].vehicle).toMatchObject({ registrationNumber: "UP32AB1234", model: "Shine" });
      expect(JSON.stringify(detail.body.data)).not.toContain("filePath");

      const file = await api()
        .get(`/api/v1/admin/drivers/${driverAProfileId}/documents/${driverADocumentId}/file`)
        .set(bearer(adminToken))
        .expect(200);
      expect(file.headers["content-type"]).toBe("image/png");
    });

    it("approves once; a second approval is an invalid transition", async () => {
      const approved = await api()
        .patch(`/api/v1/admin/drivers/${driverAProfileId}/approve`)
        .set(bearer(adminToken))
        .expect(200);
      expect(approved.body.data).toMatchObject({ driverStatus: "APPROVED", approvedAt: expect.any(String) });

      const again = await api()
        .patch(`/api/v1/admin/drivers/${driverAProfileId}/approve`)
        .set(bearer(adminToken))
        .expect(400);
      expect(again.body.code).toBe("INVALID_STATUS_TRANSITION");
    });

    it("rejects with a reason the driver can see, and allows resubmission", async () => {
      await completeOnboarding(driverBToken, "UP85CD5678");
      await api().post("/api/v1/drivers/me/submit-kyc").set(bearer(driverBToken)).expect(200);
      const driverBId = (await api().get("/api/v1/drivers/me").set(bearer(driverBToken))).body.data.id;

      await api()
        .patch(`/api/v1/admin/drivers/${driverBId}/reject`)
        .set(bearer(adminToken))
        .send({ reason: "Driving license document is unclear" })
        .expect(200);
      expect((await me(driverBToken)).driver).toEqual({
        driverStatus: "REJECTED",
        rejectionReason: "Driving license document is unclear",
      });

      await api()
        .post("/api/v1/drivers/me/documents")
        .set(bearer(driverBToken))
        .field("documentType", "DRIVING_LICENSE")
        .attach("file", PNG, { filename: "dl-clear.png", contentType: "image/png" })
        .expect(201);
      const resubmitted = await api().post("/api/v1/drivers/me/submit-kyc").set(bearer(driverBToken)).expect(200);
      expect(resubmitted.body.data.driverStatus).toBe("UNDER_REVIEW");
    });
  });

  describe("Test D — driver after approval", () => {
    it("logs in and /auth/me reports APPROVED", async () => {
      const session = await login(PHONES.driverA);
      expect(session.user).toMatchObject({ role: "DRIVER", driver: { driverStatus: "APPROVED" } });
      expect((await me(session.accessToken)).driver.driverStatus).toBe("APPROVED");
    });
  });

  describe("Test E — security", () => {
    it("401s unauthenticated and tampered-token requests", async () => {
      const anonymous = await api().get("/api/v1/users/me").expect(401);
      expect(anonymous.body.code).toBe("AUTH_UNAUTHORIZED");
      const tampered = await api()
        .get("/api/v1/users/me")
        .set(bearer(`${customerTokens.accessToken.slice(0, -2)}xx`))
        .expect(401);
      expect(tampered.body.code).toBe("AUTH_TOKEN_EXPIRED");
    });

    it("403s customers and drivers on admin endpoints", async () => {
      await api().get("/api/v1/admin/dashboard").set(bearer(customerTokens.accessToken)).expect(403);
      await api().get("/api/v1/admin/drivers").set(bearer(driverAToken)).expect(403);
      await api()
        .patch(`/api/v1/admin/drivers/${driverAProfileId}/approve`)
        .set(bearer(driverAToken))
        .expect(403);
    });

    it("403s customers on driver endpoints", async () => {
      await api().get("/api/v1/drivers/me").set(bearer(customerTokens.accessToken)).expect(403);
      await api().get("/api/v1/vehicles/my").set(bearer(customerTokens.accessToken)).expect(403);
    });

    it("hides driver A's vehicle and documents from driver B", async () => {
      const vehicle = await api().get(`/api/v1/vehicles/${driverAVehicleId}`).set(bearer(driverBToken)).expect(404);
      expect(vehicle.body.code).toBe("VEHICLE_NOT_FOUND");
      await api()
        .get(`/api/v1/drivers/me/documents/${driverADocumentId}/file`)
        .set(bearer(driverBToken))
        .expect(404);
      await api().delete(`/api/v1/drivers/me/documents/${driverADocumentId}`).set(bearer(driverBToken)).expect(404);
    });

    it("rotates refresh tokens and refuses a reused or logged-out one", async () => {
      const rotated = await api()
        .post("/api/v1/auth/refresh")
        .send({ refreshToken: customerTokens.refreshToken })
        .expect(200);
      const next = rotated.body.data.refreshToken as string;
      expect(next).not.toBe(customerTokens.refreshToken);

      const reused = await api()
        .post("/api/v1/auth/refresh")
        .send({ refreshToken: customerTokens.refreshToken })
        .expect(401);
      expect(reused.body.code).toBe("AUTH_REFRESH_TOKEN_INVALID");

      await api().post("/api/v1/auth/logout").send({ refreshToken: next }).expect(200);
      await api().post("/api/v1/auth/refresh").send({ refreshToken: next }).expect(401);
    });
  });
});
