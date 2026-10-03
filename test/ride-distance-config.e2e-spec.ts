import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { getConnectionToken } from "@nestjs/mongoose";
import { Test } from "@nestjs/testing";
import { MongoMemoryServer } from "mongodb-memory-server";
import type { Connection } from "mongoose";
import { Types } from "mongoose";
import request from "supertest";
import type { App } from "supertest/types";

/**
 * Admin-controlled trip distance limits (per ride type) and the global
 * matching / nearby-drivers radii: MongoDB is the source of truth, every
 * change applies to the next request without a restart, and a booked ride
 * keeps the limits it was booked under.
 */

const PASSWORD = "Password@123";
const PHONES = { admin: "+919860000000", customer: "+919860000001", other: "+919860000002", driver: "+919860000011" };

const ORIGIN = { address: "Prem Mandir, Vrindavan", latitude: 27.5714, longitude: 77.6716 };
// 1° of latitude along a meridian, using the same earth radius as the server's haversine.
const METERS_PER_DEGREE = (6_371_008.8 * Math.PI) / 180;
/** A point `meters` due north of ORIGIN (straight-line distance = meters, to well under a metre). */
const north = (meters: number) => ({
  address: `${Math.round(meters)} m north`,
  latitude: ORIGIN.latitude + meters / METERS_PER_DEGREE,
  longitude: ORIGIN.longitude,
});

const LIMITS = {
  BIKE: { min: 500, maxKm: 10 },
  AUTO: { min: 1_000, maxKm: 20 },
  CAB: { min: 2_000, maxKm: 30 },
} as const;
type Type = keyof typeof LIMITS;
const TYPES = Object.keys(LIMITS) as Type[];
const MARGIN = 50; // metres either side of a limit

describe("Ride distance & matching configuration (e2e)", () => {
  const originalCwd = process.cwd();
  let workDir: string;
  let mongo: MongoMemoryServer;
  let app: INestApplication<App>;
  let db: Connection;
  const tokens: Record<string, string> = {};
  const userIds: Record<string, string> = {};

  const api = () => request(app.getHttpServer());
  const as = (who: keyof typeof PHONES) => ({ Authorization: `Bearer ${tokens[who]}` });

  const estimate = (rideType: string, destination: object, who: keyof typeof PHONES = "customer") =>
    api().post("/api/v1/rides/estimate").set(as(who)).send({ rideType, pickup: ORIGIN, destination });
  const estimateAll = (destination: object) =>
    api().post("/api/v1/rides/estimate/all").set(as("customer")).send({ pickup: ORIGIN, destination });
  const book = (rideType: string, destination: object, who: keyof typeof PHONES = "customer") =>
    api().post("/api/v1/rides").set(as(who)).send({ rideType, pickup: ORIGIN, destination });
  const patchDistance = (rideType: string, body: object, who: keyof typeof PHONES = "admin") =>
    api().patch(`/api/v1/admin/ride-distance-config/${rideType}`).set(as(who)).send(body);
  const patchSettings = (body: object, who: keyof typeof PHONES = "admin") =>
    api().patch("/api/v1/admin/platform-settings").set(as(who)).send(body);
  const configDoc = (rideType: string) => db.collection("ride_distance_configs").findOne({ rideType });
  const settingsDoc = () => db.collection("platform_settings").findOne({ key: "ride-matching" });

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 60_000 } });
    workDir = await mkdtemp(join(tmpdir(), "tirvona-ride-distance-"));
    process.chdir(workDir);
    Object.assign(process.env, {
      NODE_ENV: "test",
      FINAL_FARE_MODE: "booked",
      LOG_LEVEL: "silent",
      SWAGGER_ENABLED: "false",
      MONGODB_URI: mongo.getUri(),
      MONGODB_DB_NAME: "tirvona_ride_distance",
      REDIS_URL: "",
      THROTTLE_LIMIT: "5000",
      THROTTLE_AUTH_LIMIT: "1000",
      THROTTLE_ADMIN_LOGIN_LIMIT: "1000",
      JWT_ACCESS_SECRET: randomBytes(48).toString("base64url"),
      JWT_REFRESH_SECRET: randomBytes(48).toString("base64url"),
      MATCHING_SWEEP_INTERVAL_MS: "0",
      MATCHING_REACTIVE_DISPATCH: "false",
      PAYMENT_RECONCILE_INTERVAL_MS: "0",
      BROADCAST_WORKER_INTERVAL_MS: "0",
      PLACES_PROVIDER: "none",
    });

    const { AppModule } = await import("../src/app.module");
    const { configureApp } = await import("../src/app.setup");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false, rawBody: true });
    configureApp(app);
    await app.init();
    db = app.get<Connection>(getConnectionToken());

    const { UsersService } = await import("../src/modules/users/users.service");
    const { UserRole } = await import("../src/common/types/user-role.enum");
    const users = app.get(UsersService, { strict: false });
    const roles = { admin: UserRole.ADMIN, customer: UserRole.CUSTOMER, other: UserRole.CUSTOMER, driver: UserRole.DRIVER };
    for (const who of Object.keys(PHONES) as Array<keyof typeof PHONES>) {
      const user = await users.create({ phone: PHONES[who], password: PASSWORD, role: roles[who], firstName: who });
      userIds[who] = String(user._id);
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

  // ── Migration & database ──────────────────────────────────────────────

  describe("first-boot migration", () => {
    it("gives every ride type the previous limits, and the platform the previous radii, exactly once", async () => {
      const rows = await db.collection("ride_distance_configs").find().toArray();
      const rideTypes = await db.collection("ride_types").find().toArray();
      expect(rows).toHaveLength(rideTypes.length);
      expect(rows.map((row) => row.rideType).sort()).toEqual(rideTypes.map((type) => type.code).sort());
      for (const code of ["BIKE", "AUTO", "CAB"]) {
        const row = rows.find((candidate) => candidate.rideType === code)!;
        expect(row).toMatchObject({ minDistanceMeters: 200, maxDistanceKm: 80, version: 1 });
        expect(String(row.rideTypeId)).toBe(String(rideTypes.find((type) => type.code === code)!._id));
        expect(row.updatedBy).toBeUndefined();
      }
      expect(await db.collection("platform_settings").countDocuments()).toBe(1);
      expect(await settingsDoc()).toMatchObject({ matchingRadiusKm: 8, nearbyDriversRadiusKm: 3, version: 1 });
    });

    it("is idempotent: re-running neither duplicates rows nor overwrites an admin's edit", async () => {
      await patchDistance("BIKE", { minDistanceMeters: 300, maxDistanceKm: 50 }).expect(200);
      const { RideDistanceConfigService } = await import("../src/modules/ride-config/ride-distance-config.service");
      const { PlatformSettingsService } = await import("../src/modules/ride-config/platform-settings.service");
      await app.get(RideDistanceConfigService, { strict: false }).migrateMissing();
      await app.get(PlatformSettingsService, { strict: false }).migrateMissing();
      expect(await db.collection("ride_distance_configs").countDocuments({ rideType: "BIKE" })).toBe(1);
      expect(await configDoc("BIKE")).toMatchObject({ minDistanceMeters: 300, maxDistanceKm: 50, version: 2 });
      expect(await db.collection("platform_settings").countDocuments()).toBe(1);
    });

    it("enforces one row per ride type with a unique index", async () => {
      await expect(
        db.collection("ride_distance_configs").insertOne({ rideType: "BIKE", minDistanceMeters: 1, maxDistanceKm: 1, version: 1 }),
      ).rejects.toThrow(/duplicate key/);
    });
  });

  // ── Admin API: validation, security, audit ────────────────────────────

  describe("admin API", () => {
    it("lists every ride type with its limits, units and the allowed bounds", async () => {
      const body = (await api().get("/api/v1/admin/ride-distance-config").set(as("admin")).expect(200)).body.data;
      expect(body.limits.minDistanceMeters).toEqual({ min: 1, max: 50_000 });
      const bike = body.items.find((item: { rideType: { code: string } }) => item.rideType.code === "BIKE");
      expect(bike).toMatchObject({ usable: true, config: { minDistanceMeters: 300, maxDistanceKm: 50, version: 2 } });
      expect(body.items.map((item: { rideType: { code: string } }) => item.rideType.code)).toEqual(
        expect.arrayContaining(["BIKE", "AUTO", "CAB"]),
      );
      const one = (await api().get("/api/v1/admin/ride-distance-config/AUTO").set(as("admin")).expect(200)).body.data;
      expect(one.config).toMatchObject({ rideType: "AUTO", minDistanceMeters: 200, maxDistanceKm: 80 });
      await api().get("/api/v1/admin/ride-distance-config/NOPE").set(as("admin")).expect(404);
      await api().get("/api/v1/admin/ride-distance-config/bad-code").set(as("admin")).expect(400);
    });

    it("refuses anyone who is not an admin", async () => {
      for (const who of ["customer", "driver"] as const) {
        await api().get("/api/v1/admin/ride-distance-config").set(as(who)).expect(403);
        await patchDistance("BIKE", { maxDistanceKm: 5 }, who).expect(403);
        await api().get("/api/v1/admin/platform-settings").set(as(who)).expect(403);
        await patchSettings({ matchingRadiusKm: 5 }, who).expect(403);
      }
      await api().get("/api/v1/admin/ride-distance-config").expect(401);
      await api().patch("/api/v1/admin/ride-distance-config/BIKE").send({ maxDistanceKm: 5 }).expect(401);
      await api().patch("/api/v1/admin/platform-settings").send({ matchingRadiusKm: 5 }).expect(401);
      expect(await configDoc("BIKE")).toMatchObject({ minDistanceMeters: 300, maxDistanceKm: 50, version: 2 });
    });

    it.each([
      ["an empty body", {}],
      ["a zero minimum", { minDistanceMeters: 0 }],
      ["a negative minimum", { minDistanceMeters: -10 }],
      ["a fractional minimum", { minDistanceMeters: 10.5 }],
      ["a text minimum", { minDistanceMeters: "far" }],
      ["a zero maximum", { maxDistanceKm: 0 }],
      ["a negative maximum", { maxDistanceKm: -3 }],
      ["a text maximum", { maxDistanceKm: "lots" }],
      ["a null maximum", { maxDistanceKm: null }],
      ["a maximum below the stored minimum", { maxDistanceKm: 0.1 }],
      ["a minimum above the maximum", { minDistanceMeters: 30_000, maxDistanceKm: 20 }],
      ["a minimum equal to the maximum", { minDistanceMeters: 20_000, maxDistanceKm: 20 }],
      ["an absurd maximum", { maxDistanceKm: 99_999 }],
      ["an unknown field", { maxDistanceKm: 20, surprise: true }],
    ])("rejects %s and changes nothing", async (_label, body) => {
      const before = await configDoc("AUTO");
      await patchDistance("AUTO", body).expect(400);
      expect(await configDoc("AUTO")).toEqual(before);
    });

    it("rejects bad radii and changes nothing", async () => {
      const before = await settingsDoc();
      for (const body of [{}, { matchingRadiusKm: 0 }, { matchingRadiusKm: -1 }, { matchingRadiusKm: 101 }, { matchingRadiusKm: "far" }, { nearbyDriversRadiusKm: 0 }, { nearbyDriversRadiusKm: 51 }, { nearbyDriversRadiusKm: 3, extra: 1 }])
        await patchSettings(body).expect(400);
      expect(await settingsDoc()).toEqual(before);
    });

    it("records who changed what, with before and after, and bumps the version and timestamp", async () => {
      const before = await configDoc("AUTO");
      const response = (await patchDistance("AUTO", { minDistanceMeters: 1_000, maxDistanceKm: 20 }).expect(200)).body.data;
      expect(response.config).toMatchObject({ minDistanceMeters: 1_000, maxDistanceKm: 20, version: 2, updatedBy: userIds.admin });
      const after = await configDoc("AUTO");
      expect(after!.version).toBe(2);
      expect(String(after!.updatedBy)).toBe(userIds.admin);
      expect(after!.updatedAt.getTime()).toBeGreaterThanOrEqual(before!.updatedAt.getTime());
      expect(await db.collection("ride_distance_configs").countDocuments({ rideType: "AUTO" })).toBe(1);

      const audit = await db.collection("admin_audit_logs").find({ targetType: "RIDE_DISTANCE_CONFIG", targetId: "AUTO" }).toArray();
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        action: "ride_distance_config.update",
        metadata: { before: { minDistanceMeters: 200, maxDistanceKm: 80 }, after: { minDistanceMeters: 1_000, maxDistanceKm: 20 } },
      });
      expect(String(audit[0].adminId)).toBe(userIds.admin);
    });

    it("keeps the other field when only one is sent, and re-validates the pair", async () => {
      await patchDistance("CAB", { maxDistanceKm: 30 }).expect(200);
      expect(await configDoc("CAB")).toMatchObject({ minDistanceMeters: 200, maxDistanceKm: 30 });
      await patchDistance("CAB", { minDistanceMeters: 2_000 }).expect(200);
      expect(await configDoc("CAB")).toMatchObject({ minDistanceMeters: 2_000, maxDistanceKm: 30 });
      await patchDistance("BIKE", { minDistanceMeters: 500, maxDistanceKm: 10 }).expect(200);
    });

    it("updates the platform settings independently and audits them", async () => {
      await patchSettings({ matchingRadiusKm: 6 }).expect(200);
      expect(await settingsDoc()).toMatchObject({ matchingRadiusKm: 6, nearbyDriversRadiusKm: 3, version: 2 });
      await patchSettings({ nearbyDriversRadiusKm: 4 }).expect(200);
      expect(await settingsDoc()).toMatchObject({ matchingRadiusKm: 6, nearbyDriversRadiusKm: 4, version: 3 });
      const view = (await api().get("/api/v1/admin/platform-settings").set(as("admin")).expect(200)).body.data;
      expect(view.settings).toMatchObject({ matchingRadiusKm: 6, nearbyDriversRadiusKm: 4, updatedBy: userIds.admin });
      expect(view.limits.matchingRadiusKm).toEqual({ min: 0.5, max: 100 });
      expect(await db.collection("platform_settings").countDocuments()).toBe(1);
      const audit = await db.collection("admin_audit_logs").find({ targetType: "PLATFORM_SETTINGS" }).toArray();
      expect(audit).toHaveLength(2);
      await patchSettings({ matchingRadiusKm: 8, nearbyDriversRadiusKm: 3 }).expect(200);
    });
  });

  // ── Estimates: per ride type, at the boundaries ───────────────────────

  describe("estimates use each ride type's own limits", () => {
    // Limits now: BIKE 500 m–10 km, AUTO 1 km–20 km, CAB 2 km–30 km.
    for (const type of TYPES) {
      const { min, maxKm } = LIMITS[type];
      it(`${type}: ${min} m – ${maxKm} km, below / above each limit`, async () => {
        const tooShort = await estimate(type, north(min - MARGIN)).expect(400);
        expect(tooShort.body).toMatchObject({ code: "RIDE_TOO_SHORT", data: { minDistanceMeters: min } });
        await estimate(type, north(min + MARGIN)).expect(200);
        await estimate(type, north(maxKm * 1000 - MARGIN)).expect(200);
        const tooLong = await estimate(type, north(maxKm * 1000 + MARGIN)).expect(400);
        expect(tooLong.body).toMatchObject({ code: "RIDE_TOO_LONG", data: { maxDistanceMeters: maxKm * 1000 } });
      });
    }

    it("a trip one ride type refuses is still quoted for the others", async () => {
      // 15 km: too long for Bike (10 km), fine for Auto (20) and Cab (30).
      const quoted = (await estimateAll(north(15_000)).expect(200)).body.data.map((entry: { rideType: string }) => entry.rideType);
      expect(quoted).toEqual(["AUTO", "CAB"]);
      // 700 m: too short for Auto and Cab.
      expect((await estimateAll(north(700)).expect(200)).body.data.map((entry: { rideType: string }) => entry.rideType)).toEqual(["BIKE"]);
    });

    it("says why when no ride type can take the trip", async () => {
      expect((await estimateAll(north(100)).expect(400)).body.code).toBe("RIDE_TOO_SHORT");
      expect((await estimateAll(north(45_000)).expect(400)).body.code).toBe("RIDE_TOO_LONG");
    });

    it("changing one ride type leaves the others alone", async () => {
      const probes = async () =>
        Object.fromEntries(
          await Promise.all(TYPES.map(async (type) => [type, (await estimate(type, north(8_000))).status] as const)),
        );
      expect(await probes()).toEqual({ BIKE: 200, AUTO: 200, CAB: 200 });

      for (const changed of TYPES) {
        const original = LIMITS[changed];
        await patchDistance(changed, { maxDistanceKm: 5 }).expect(200);
        const now = await probes();
        for (const type of TYPES) expect(now[type]).toBe(type === changed ? 400 : 200);
        await patchDistance(changed, { maxDistanceKm: original.maxKm }).expect(200);
        expect(await probes()).toEqual({ BIKE: 200, AUTO: 200, CAB: 200 });
      }
    });

    it("an admin change applies to the very next request, with no restart", async () => {
      await estimate("CAB", north(20_000)).expect(200);
      await patchDistance("CAB", { maxDistanceKm: 15 }).expect(200);
      expect((await estimate("CAB", north(20_000)).expect(400)).body.code).toBe("RIDE_TOO_LONG");
      await patchDistance("CAB", { maxDistanceKm: 30 }).expect(200);
      await estimate("CAB", north(20_000)).expect(200);
    });
  });

  // ── Booking: revalidated now, snapshot kept ───────────────────────────

  describe("booking", () => {
    it("revalidates against the current limits, not against an earlier estimate", async () => {
      const destination = north(20_000);
      await estimate("CAB", destination, "other").expect(200); // the customer saw a valid quote…
      await patchDistance("CAB", { maxDistanceKm: 15 }).expect(200); // …then the admin tightened the limit
      const response = await book("CAB", destination, "other").expect(400);
      expect(response.body).toMatchObject({ code: "RIDE_TOO_LONG", data: { maxDistanceMeters: 15_000 } });
      expect(await db.collection("rides").countDocuments({ customerId: new Types.ObjectId(userIds.other) })).toBe(0);
      await patchDistance("CAB", { maxDistanceKm: 30 }).expect(200);
    });

    it("applies the same rule to the promo preview", async () => {
      const response = await api()
        .post("/api/v1/promotions/validate")
        .set(as("customer"))
        .send({ code: "ANYCODE", rideType: "BIKE", pickup: ORIGIN, destination: north(11_000) })
        .expect(400);
      expect(response.body.code).toBe("RIDE_TOO_LONG");
    });

    it("stores the applied limits on the ride, and later edits never change them", async () => {
      const response = await book("BIKE", north(2_000)).expect(201);
      const rideId = response.body.data.id as string;
      const stored = await db.collection("rides").findOne({ _id: new Types.ObjectId(rideId) });
      const bike = await configDoc("BIKE");
      expect(stored!.distancePolicy).toEqual({
        rideType: "BIKE",
        minDistanceMeters: 500,
        maxDistanceMeters: 10_000,
        configId: String(bike!._id),
        configVersion: bike!.version,
      });

      await patchDistance("BIKE", { minDistanceMeters: 1_500, maxDistanceKm: 4 }).expect(200);
      const afterEdit = await db.collection("rides").findOne({ _id: new Types.ObjectId(rideId) });
      expect(afterEdit!.distancePolicy).toEqual(stored!.distancePolicy);
      expect((await configDoc("BIKE"))!.version).toBe(bike!.version + 1);
      await patchDistance("BIKE", { minDistanceMeters: 500, maxDistanceKm: 10 }).expect(200);
    });
  });

  // ── Matching radius & nearby drivers ──────────────────────────────────

  describe("driver radii", () => {
    const profile = (code: string, meters: number) => {
      const point = north(meters);
      return {
        userId: new Types.ObjectId(),
        driverCode: code,
        driverStatus: "APPROVED",
        isOnline: true,
        isAvailable: true,
        activeVehicleType: "AUTO",
        currentLocation: { type: "Point", coordinates: [point.longitude, point.latitude] },
        locationUpdatedAt: new Date(),
        ratingAverage: 0,
        ratingCount: 0,
        ratingSum: 0,
        totalRides: 0,
      };
    };

    beforeAll(async () => {
      await db.collection("driver_profiles").insertMany([profile("D-2KM", 2_000), profile("D-4KM", 4_000), profile("D-6KM", 6_000), profile("D-9KM", 9_000)]);
    });

    const candidates = async (): Promise<string[]> => {
      const { MatchingService } = await import("../src/modules/matching/matching.service");
      const { VehicleType } = await import("../src/modules/vehicles/schemas/vehicle.schema");
      const found = await app.get(MatchingService, { strict: false }).findCandidates({ pickup: ORIGIN, vehicleType: VehicleType.AUTO, limit: 20 });
      const ids = found.map((candidate) => String(candidate.userId));
      const rows = await db.collection("driver_profiles").find({ userId: { $in: found.map((candidate) => candidate.userId) } }).toArray();
      return ids.map((id) => rows.find((row) => String(row.userId) === id)!.driverCode as string);
    };
    const nearby = async () =>
      (await api().get("/api/v1/rides/nearby-drivers").query({ latitude: ORIGIN.latitude, longitude: ORIGIN.longitude }).set(as("customer")).expect(200)).body.data;

    it("the matching radius really changes which drivers are candidates (8 → 5 → 10 km)", async () => {
      expect(await candidates()).toEqual(["D-2KM", "D-4KM", "D-6KM"]);
      await patchSettings({ matchingRadiusKm: 5 }).expect(200);
      expect(await candidates()).toEqual(["D-2KM", "D-4KM"]);
      await patchSettings({ matchingRadiusKm: 10 }).expect(200);
      expect(await candidates()).toEqual(["D-2KM", "D-4KM", "D-6KM", "D-9KM"]);
      await patchSettings({ matchingRadiusKm: 8 }).expect(200);
    });

    it("the nearby-drivers radius changes what the Home map gets, and not the matching radius", async () => {
      const count = async () => (await nearby()).drivers.length as number;
      expect((await nearby()).radiusMeters).toBe(3_000);
      expect(await count()).toBe(1); // 2 km
      await patchSettings({ nearbyDriversRadiusKm: 5 }).expect(200);
      expect((await nearby()).radiusMeters).toBe(5_000);
      expect(await count()).toBe(2);
      await patchSettings({ nearbyDriversRadiusKm: 7 }).expect(200);
      expect(await count()).toBe(3);
      await patchSettings({ nearbyDriversRadiusKm: 1 }).expect(200);
      expect(await count()).toBe(0);
      // The matching radius was never touched by those edits.
      expect(await candidates()).toEqual(["D-2KM", "D-4KM", "D-6KM"]);
      await patchSettings({ nearbyDriversRadiusKm: 3 }).expect(200);
    });

    it("the quote's driver supply follows the matching radius", async () => {
      const supply = async () =>
        ((await estimate("AUTO", north(5_000)).expect(200)).body.data as { driversNearby: number }).driversNearby;
      expect(await supply()).toBe(3);
      await patchSettings({ matchingRadiusKm: 5 }).expect(200);
      expect(await supply()).toBe(2);
      await patchSettings({ matchingRadiusKm: 8 }).expect(200);
    });
  });

  // ── Ride type lifecycle ───────────────────────────────────────────────

  describe("new ride types", () => {
    const base = { code: "CAB_XL", displayName: "Cab XL", icon: "cab_xl", vehicleType: "CAB", seatCapacity: 6 };
    const tariff = { baseFare: 60, perKmRate: 18, perMinuteRate: 2, minimumFare: 90 };
    const create = (body: object) => api().post("/api/v1/admin/ride-types").set(as("admin")).send({ ...base, ...body });

    it("cannot be created active without distance limits, nor with unsound ones", async () => {
      expect((await create({ isActive: true, pricing: tariff }).expect(400)).body.code).toBe("RIDE_TYPE_DISTANCE_REQUIRED");
      await create({ isActive: true, pricing: tariff, distance: { minDistanceMeters: 5_000, maxDistanceKm: 2 } }).expect(400);
      expect(await db.collection("ride_types").countDocuments({ code: "CAB_XL" })).toBe(0);
      expect(await db.collection("ride_distance_configs").countDocuments({ rideType: "CAB_XL" })).toBe(0);
    });

    it("starts without limits when created switched off, and cannot be activated until they are set", async () => {
      await create({}).expect(201);
      expect(await db.collection("ride_distance_configs").countDocuments({ rideType: "CAB_XL" })).toBe(0);
      const row = (await api().get("/api/v1/admin/ride-distance-config/CAB_XL").set(as("admin")).expect(200)).body.data;
      expect(row).toMatchObject({ config: null, usable: false });

      await api().patch("/api/v1/admin/pricing/CAB_XL").set(as("admin")).send(tariff).expect(200);
      const refused = await api().patch("/api/v1/admin/ride-types/CAB_XL").set(as("admin")).send({ isActive: true }).expect(400);
      expect(refused.body.code).toBe("RIDE_TYPE_DISTANCE_REQUIRED");

      // One value alone is not enough for a ride type with no limits yet.
      expect((await patchDistance("CAB_XL", { maxDistanceKm: 40 }).expect(400)).body.code).toBe("RIDE_DISTANCE_CONFIG_INCOMPLETE");
      await patchDistance("CAB_XL", { minDistanceMeters: 1_000, maxDistanceKm: 40 }).expect(200);
      expect(await configDoc("CAB_XL")).toMatchObject({ minDistanceMeters: 1_000, maxDistanceKm: 40, version: 1 });
      expect(String((await configDoc("CAB_XL"))!.rideTypeId)).toBe(String((await db.collection("ride_types").findOne({ code: "CAB_XL" }))!._id));

      await api().patch("/api/v1/admin/ride-types/CAB_XL").set(as("admin")).send({ isActive: true }).expect(200);
      await estimate("CAB_XL", north(5_000)).expect(200);
      expect((await estimate("CAB_XL", north(500)).expect(400)).body.code).toBe("RIDE_TOO_SHORT");
      expect((await estimate("CAB_XL", north(41_000)).expect(400)).body.code).toBe("RIDE_TOO_LONG");
    });

    it("can be created active in one step with its limits", async () => {
      await api().post("/api/v1/admin/ride-types").set(as("admin")).send({
        code: "AUTO_PLUS", displayName: "Auto Plus", icon: "auto", vehicleType: "AUTO", seatCapacity: 3,
        isActive: true, pricing: tariff, distance: { minDistanceMeters: 300, maxDistanceKm: 25 },
      }).expect(201);
      expect(await configDoc("AUTO_PLUS")).toMatchObject({ minDistanceMeters: 300, maxDistanceKm: 25, version: 1 });
      await estimate("AUTO_PLUS", north(10_000)).expect(200);
    });
  });

  // ── Failing safely ────────────────────────────────────────────────────

  describe("missing or unusable configuration", () => {
    it("a ride type without limits cannot be quoted or booked, and is left out of the list (never a made-up default)", async () => {
      const saved = await configDoc("CAB");
      await db.collection("ride_distance_configs").deleteOne({ rideType: "CAB" });

      const quote = await estimate("CAB", north(5_000)).expect(503);
      expect(quote.body).toMatchObject({ code: "RIDE_DISTANCE_CONFIG_MISSING", data: { rideType: "CAB" } });
      expect((await book("CAB", north(5_000), "other").expect(503)).body.code).toBe("RIDE_DISTANCE_CONFIG_MISSING");
      expect(await db.collection("rides").countDocuments({ customerId: new Types.ObjectId(userIds.other) })).toBe(0);
      const list = (await estimateAll(north(5_000)).expect(200)).body.data.map((entry: { rideType: string }) => entry.rideType);
      expect(list).not.toContain("CAB");
      expect(list).toContain("AUTO");
      const row = (await api().get("/api/v1/admin/ride-distance-config/CAB").set(as("admin")).expect(200)).body.data;
      expect(row).toMatchObject({ config: null, usable: false });

      // The other ride types are unaffected, and the admin can repair it from the panel.
      await estimate("AUTO", north(5_000)).expect(200);
      await patchDistance("CAB", { minDistanceMeters: saved!.minDistanceMeters, maxDistanceKm: saved!.maxDistanceKm }).expect(200);
      await estimate("CAB", north(5_000)).expect(200);
    });

    it("refuses stored values that are unsound", async () => {
      await db.collection("ride_distance_configs").updateOne({ rideType: "CAB" }, { $set: { minDistanceMeters: 40_000, maxDistanceKm: 1 } });
      expect((await estimate("CAB", north(500)).expect(503)).body.code).toBe("RIDE_DISTANCE_CONFIG_INVALID");
      expect((await api().get("/api/v1/admin/ride-distance-config/CAB").set(as("admin")).expect(200)).body.data.usable).toBe(false);
      await patchDistance("CAB", { minDistanceMeters: 2_000, maxDistanceKm: 30 }).expect(200);
      await estimate("CAB", north(5_000)).expect(200);
    });

    it("without platform settings, matching and the Home map fail loudly instead of using a default", async () => {
      const saved = await settingsDoc();
      await db.collection("platform_settings").deleteOne({ key: "ride-matching" });

      const home = await api().get("/api/v1/rides/nearby-drivers").query({ latitude: ORIGIN.latitude, longitude: ORIGIN.longitude }).set(as("customer")).expect(503);
      expect(home.body.code).toBe("PLATFORM_SETTINGS_MISSING");
      const { MatchingService } = await import("../src/modules/matching/matching.service");
      const { VehicleType } = await import("../src/modules/vehicles/schemas/vehicle.schema");
      await expect(
        app.get(MatchingService, { strict: false }).findCandidates({ pickup: ORIGIN, vehicleType: VehicleType.AUTO }),
      ).rejects.toMatchObject({ response: { code: "PLATFORM_SETTINGS_MISSING" } });
      // A quote's driver supply is decoration: the estimate itself still works.
      expect((await estimate("AUTO", north(5_000)).expect(200)).body.data.driversNearby).toBe(0);

      // A partial first save cannot invent the missing half…
      await patchSettings({ matchingRadiusKm: 5 }).expect(400);
      // …both together restore it.
      await patchSettings({ matchingRadiusKm: saved!.matchingRadiusKm, nearbyDriversRadiusKm: saved!.nearbyDriversRadiusKm }).expect(200);
      expect(await db.collection("platform_settings").countDocuments()).toBe(1);
      await api().get("/api/v1/rides/nearby-drivers").query({ latitude: ORIGIN.latitude, longitude: ORIGIN.longitude }).set(as("customer")).expect(200);
    });

    it("refuses unsound stored radii", async () => {
      await db.collection("platform_settings").updateOne({ key: "ride-matching" }, { $set: { matchingRadiusKm: -2 } });
      const response = await api().get("/api/v1/rides/nearby-drivers").query({ latitude: ORIGIN.latitude, longitude: ORIGIN.longitude }).set(as("customer")).expect(503);
      expect(response.body.code).toBe("PLATFORM_SETTINGS_INVALID");
      await patchSettings({ matchingRadiusKm: 8 }).expect(200);
    });
  });
});
