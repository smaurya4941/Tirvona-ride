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

/**
 * Admin live driver map (GET /admin/live/drivers[/:id]), the one-vehicle
 * rule for drivers, and the relaxed password policy.
 */

const PASSWORD = "Password@123";
const PHONES = {
  admin: "+919860000001",
  online: "+919860000002",
  offline: "+919860000003",
  onboarding: "+919860000004",
  customer: "+919860000005",
} as const;
type Who = keyof typeof PHONES;

describe("Live drivers, one vehicle per driver, passwords (e2e)", () => {
  const originalCwd = process.cwd();
  let workDir: string;
  let mongo: MongoMemoryServer;
  let app: INestApplication<App>;
  let db: Connection;
  const tokens = {} as Record<Who, string>;
  const driverIds = {} as Record<Who, string>;

  const api = () => request(app.getHttpServer());
  const as = (who: Who) => ({ Authorization: `Bearer ${tokens[who]}` });

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 60_000 } });
    workDir = await mkdtemp(join(tmpdir(), "tirvona-ride-live-"));
    process.chdir(workDir);
    Object.assign(process.env, {
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      SWAGGER_ENABLED: "false",
      MONGODB_URI: mongo.getUri(),
      MONGODB_DB_NAME: "tirvona_ride_live_drivers",
      REDIS_URL: "",
      THROTTLE_LIMIT: "1000",
      THROTTLE_AUTH_LIMIT: "1000",
      BROADCAST_WORKER_INTERVAL_MS: "0",
      PAYMENT_RECONCILE_INTERVAL_MS: "0",
      MATCHING_SWEEP_INTERVAL_MS: "0",
      JWT_ACCESS_SECRET: randomBytes(48).toString("base64url"),
      JWT_REFRESH_SECRET: randomBytes(48).toString("base64url"),
      WHATSAPP_PROVIDER: "log",
    });

    const { AppModule } = await import("../src/app.module");
    const { configureApp } = await import("../src/app.setup");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false, rawBody: true });
    configureApp(app);
    await app.init();
    db = app.get<Connection>(getConnectionToken());

    const { UsersService } = await import("../src/modules/users/users.service");
    const { DriversService } = await import("../src/modules/drivers/drivers.service");
    const { UserRole } = await import("../src/common/types/user-role.enum");
    const users = app.get(UsersService, { strict: false });
    const drivers = app.get(DriversService, { strict: false });

    await users.create({ phone: PHONES.admin, password: PASSWORD, role: UserRole.ADMIN, firstName: "Ops" });
    await users.create({ phone: PHONES.customer, password: PASSWORD, role: UserRole.CUSTOMER, firstName: "Meera" });
    const plates = { online: "UP85DD0001", offline: "UP85DD0002", onboarding: "UP85DD0003" } as const;
    for (const who of ["online", "offline", "onboarding"] as const) {
      const user = await users.create({ phone: PHONES[who], password: PASSWORD, role: UserRole.DRIVER, firstName: "Rahul", lastName: who });
      const profile = await drivers.createProfileForUser(user._id.toString());
      driverIds[who] = profile._id.toHexString();
      await db
        .collection("driver_profiles")
        .updateOne({ _id: profile._id }, { $set: { driverStatus: who === "onboarding" ? "PENDING" : "APPROVED" } });
      await db.collection("vehicles").insertOne({
        driverId: profile._id,
        vehicleType: "AUTO",
        registrationNumber: plates[who],
        isActive: true,
      });
    }
    for (const who of Object.keys(PHONES) as Who[]) {
      const response = await api().post("/api/v1/auth/login").send({ phone: PHONES[who], password: PASSWORD }).expect(200);
      tokens[who] = response.body.data.accessToken as string;
    }
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
    process.chdir(originalCwd);
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  describe("admin live map", () => {
    it("is admin-only", async () => {
      await api().get("/api/v1/admin/live/drivers").expect(401);
      await api().get("/api/v1/admin/live/drivers").set(as("customer")).expect(403);
      await api().get("/api/v1/admin/live/drivers").set(as("online")).expect(403);
    });

    it("lists only online drivers, with their latest position and vehicle", async () => {
      await api()
        .patch("/api/v1/drivers/availability")
        .set(as("online"))
        .send({ isOnline: true, latitude: 27.4924, longitude: 77.6737 })
        .expect(200);

      const response = await api().get("/api/v1/admin/live/drivers").set(as("admin")).expect(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      const report = response.body.data;
      expect(report.truncated).toBe(false);
      expect(report.items).toHaveLength(1);
      expect(report.items[0]).toMatchObject({
        driverId: driverIds.online,
        name: "Rahul online",
        isOnline: true,
        vehicle: { registrationNumber: "UP85DD0001" },
        location: { latitude: 27.4924, longitude: 77.6737, fresh: true },
      });
    });

    it("follows the driver as new fixes arrive", async () => {
      await api()
        .patch("/api/v1/drivers/availability")
        .set(as("online"))
        .send({ isOnline: true, latitude: 27.5, longitude: 77.68 })
        .expect(200);
      const one = (await api().get(`/api/v1/admin/live/drivers/${driverIds.online}`).set(as("admin")).expect(200)).body.data;
      expect(one.location).toMatchObject({ latitude: 27.5, longitude: 77.68 });
    });

    it("shows one offline driver without a position, and 404s for unknown ids", async () => {
      const one = (await api().get(`/api/v1/admin/live/drivers/${driverIds.offline}`).set(as("admin")).expect(200)).body.data;
      expect(one).toMatchObject({ isOnline: false, driverStatus: "APPROVED" });
      expect(one.location).toBeUndefined();
      await api().get("/api/v1/admin/live/drivers/000000000000000000000000").set(as("admin")).expect(404);
      await api().get("/api/v1/admin/live/drivers/not-an-id").set(as("admin")).expect(400);
    });
  });

  describe("one vehicle per driver", () => {
    it("refuses a second active vehicle and points to a change request", async () => {
      const response = await api()
        .post("/api/v1/vehicles")
        .set(as("onboarding"))
        .send({ vehicleType: "CAB", registrationNumber: "UP85ZZ9999" })
        .expect(409);
      expect(response.body.code).toBe("DRIVER_VEHICLE_LIMIT");
      expect(await db.collection("vehicles").countDocuments({ driverId: { $exists: true }, isActive: true })).toBe(3);
    });

    it("lets a driver register a new vehicle once the old one is deactivated", async () => {
      const mine = (await api().get("/api/v1/vehicles/my").set(as("onboarding")).expect(200)).body.data;
      await api().delete(`/api/v1/vehicles/${mine[0].id}`).set(as("onboarding")).expect(200);
      await api()
        .post("/api/v1/vehicles")
        .set(as("onboarding"))
        .send({ vehicleType: "CAB", registrationNumber: "UP85ZZ9999" })
        .expect(201);
    });

    it("an approved driver cannot add a vehicle directly", async () => {
      await api()
        .post("/api/v1/vehicles")
        .set(as("online"))
        .send({ vehicleType: "CAB", registrationNumber: "UP85YY8888" })
        .expect(400, /INVALID_DRIVER_STATUS/);
    });
  });

  describe("passwords", () => {
    it("accepts any password of 6 to 128 characters, nothing else", async () => {
      const register = (phone: string, password: string) =>
        api().post("/api/v1/auth/register").send({ firstName: "Asha", phone, password, role: "CUSTOMER" });
      await register("+919860000091", "abcdef").expect(202);
      await register("+919860000092", "123456").expect(202);
      await register("+919860000093", "abc12").expect(400);
      await register("+919860000094", "a".repeat(129)).expect(400);
    });
  });
});
