import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { getModelToken } from "@nestjs/mongoose";
import { Test } from "@nestjs/testing";
import { MongoMemoryServer } from "mongodb-memory-server";
import type { Model } from "mongoose";
import { Types } from "mongoose";
import request from "supertest";
import type { App } from "supertest/types";
import { PushGateway } from "../src/modules/notifications/push/push.gateway";
import type {
  PushMessage,
  PushResult,
} from "../src/modules/notifications/push/push.gateway";

/**
 * Tirvona Circuit (docs/circuit/README.md), end to end:
 * Admin builds and publishes a package → customer browses, estimates and books
 * (idempotently) → matching → driver accepts, arrives, starts with the OTP →
 * stop by stop (server-owned order, arrival radius, repeat-safe commands) →
 * blocked stop resolved by Admin → completion priced on actual usage →
 * payment, monitor warnings, admin end-early, admin lists, live board, reports.
 */

const PASSWORD = "Password@123";
const PHONES = {
  admin: "+919830000000",
  customer: "+919830000001",
  customer2: "+919830000002",
  driver: "+919830000011",
} as const;
type Who = keyof typeof PHONES;

const PICKUP = {
  address: "Hotel Brijwasi, Vrindavan",
  latitude: 27.5714,
  longitude: 77.6716,
};
const NEAR_PICKUP = { latitude: 27.5716, longitude: 77.6718 };
const STOPS = [
  "featured:banke-bihari",
  "featured:nidhivan",
  "featured:keshi-ghat",
];
const STOP_COORDS = [
  { latitude: 27.5806, longitude: 77.7006 },
  { latitude: 27.5829, longitude: 77.6987 },
  { latitude: 27.5853, longitude: 77.6964 },
];
const METERS_PER_DEGREE = 111_195;
const HOUR = 3600;
/** Each allowed vehicle has its own price on a circuit. */
const AUTO_PRICE = {
  rideType: "AUTO",
  basePrice: 600,
  extraDistanceRatePerKm: 15,
  extraDurationRatePerHour: 50,
};
const BIKE_PRICE = {
  rideType: "BIKE",
  basePrice: 350,
  extraDistanceRatePerKm: 8,
  extraDurationRatePerHour: 30,
};

/** "HH:mm" in IST for an offset from now (wraps around midnight). */
const istClock = (offsetMinutes: number): string => {
  const shifted = new Date(Date.now() + offsetMinutes * 60_000);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(shifted);
  return `${parts.find((p) => p.type === "hour")?.value}:${parts.find((p) => p.type === "minute")?.value}`;
};

class FakePush extends PushGateway {
  readonly isConfigured = false;
  async send(tokens: string[], _message: PushMessage): Promise<PushResult[]> {
    return tokens.map((token) => ({
      token,
      delivered: false,
      tokenInvalid: false,
    }));
  }
}

interface StopView {
  order: number;
  name: string;
  status: string;
}
interface CircuitRide {
  id: string;
  rideCode: string;
  status: string;
  kind: string;
  paymentStatus: string;
  otp?: { code: string };
  fare: {
    estimatedFare: number;
    finalFare?: number;
    final?: {
      total: number;
      baseFare: number;
      distanceCharge: number;
      timeCharge: number;
      distanceSource: string;
    };
  };
  circuit: {
    name: string;
    stops: StopView[];
    currentStopOrder: number;
    currentStop?: StopView;
    readyToComplete: boolean;
    pricing: { basePrice: number };
    usage: { elapsedSeconds: number; distanceMeters: number };
    exception?: { type: string; stopOrder: number };
    settlement?: { extraKm: number; extraBlocks: number; completedBy: string };
  };
}

describe("Tirvona Circuit (e2e)", () => {
  const originalCwd = process.cwd();
  let workDir: string;
  let mongo: MongoMemoryServer;
  let app: INestApplication<App>;
  const tokens = {} as Record<Who, string>;
  let driverProfileId: string;
  let rideModel: Model<{ startedAt?: Date; driverId?: Types.ObjectId }>;
  let checkpointModel: Model<unknown>;
  let driverModel: Model<{
    isAvailable: boolean;
    currentRideId?: Types.ObjectId;
    circuitEligible?: boolean;
  }>;
  let notificationModel: Model<{
    type: string;
    userId: Types.ObjectId;
    rideId?: Types.ObjectId;
  }>;
  let remember: (
    driverId: string,
    at: { latitude: number; longitude: number },
  ) => void;
  let monitorTick: (
    now?: Date,
  ) => Promise<{ checked: number; warnings: number }>;
  let packageId: string;

  const api = () => request(app.getHttpServer());
  const as = (who: Who) => ({ Authorization: `Bearer ${tokens[who]}` });
  const admin = (path = "") => `/api/v1/admin/circuit-packages${path}`;
  const circuit = (path = "") => `/api/v1/circuit-rides${path}`;
  const estimateBody = (overrides: Record<string, unknown> = {}) => ({
    packageId,
    rideType: "AUTO",
    pickup: PICKUP,
    passengers: 2,
    ...overrides,
  });
  const driverAt = (index: number) =>
    remember(driverProfileId, STOP_COORDS[index]);

  async function goOnline() {
    await api()
      .patch("/api/v1/drivers/availability")
      .set(as("driver"))
      .send({ isOnline: true, ...NEAR_PICKUP })
      .expect(200);
  }

  /** Book → accept → arrived → start (customer's OTP), via the circuit paths. */
  async function startedCircuit(who: Who = "customer"): Promise<CircuitRide> {
    await goOnline();
    remember(driverProfileId, NEAR_PICKUP);
    const booked = (
      await api().post(circuit()).set(as(who)).send(estimateBody()).expect(201)
    ).body.data as CircuitRide;
    expect(booked.status).toBe("DRIVER_ASSIGNED");
    await api()
      .post(circuit(`/${booked.id}/accept`))
      .set(as("driver"))
      .expect(200);
    await api()
      .post(circuit(`/${booked.id}/arrived`))
      .set(as("driver"))
      .expect(200);
    const otp = (
      (
        await api()
          .get(circuit(`/${booked.id}`))
          .set(as(who))
          .expect(200)
      ).body.data as CircuitRide
    ).otp!.code;
    return (
      await api()
        .post(circuit(`/${booked.id}/start`))
        .set(as("driver"))
        .send({ otp })
        .expect(200)
    ).body.data as CircuitRide;
  }

  /** Rewrites the circuit's trip: started `hours` ago with a clean trail covering `km`, heading north. */
  async function driveTrip(
    rideId: string,
    hours: number,
    km: number,
  ): Promise<void> {
    const startedAt = new Date(Date.now() - hours * HOUR * 1000);
    await rideModel.updateOne({ _id: rideId }, { $set: { startedAt } }).exec();
    await checkpointModel
      .deleteMany({ rideId: new Types.ObjectId(rideId) })
      .exec();
    const ride = (await rideModel.findById(rideId).lean().exec())!;
    const fixes = Math.floor((hours * HOUR) / 15);
    const step = (km * 1000) / fixes;
    await checkpointModel.insertMany(
      Array.from({ length: fixes + 1 }, (_, index) => ({
        rideId: new Types.ObjectId(rideId),
        driverId: ride.driverId,
        kind: index === 0 ? "STARTED" : "TRIP",
        location: {
          type: "Point",
          coordinates: [
            PICKUP.longitude,
            PICKUP.latitude + (index * step) / METERS_PER_DEGREE,
          ],
        },
        source: "LIVE",
        recordedAt: new Date(startedAt.getTime() + index * 15_000),
      })),
    );
  }

  const stopCommand = (rideId: string, order: number, command: string) =>
    api()
      .post(circuit(`/${rideId}/stops/${order}/${command}`))
      .set(as("driver"))
      .send({});

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create({
      instance: { launchTimeout: 60_000 },
    });
    workDir = await mkdtemp(join(tmpdir(), "tirvona-ride-circuit-"));
    process.chdir(workDir);
    Object.assign(process.env, {
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      SWAGGER_ENABLED: "false",
      MONGODB_URI: mongo.getUri(),
      MONGODB_DB_NAME: "tirvona_ride_circuit",
      REDIS_URL: "",
      THROTTLE_LIMIT: "5000",
      THROTTLE_AUTH_LIMIT: "1000",
      THROTTLE_ADMIN_LOGIN_LIMIT: "1000",
      BROADCAST_WORKER_INTERVAL_MS: "0",
      PAYMENT_RECONCILE_INTERVAL_MS: "0",
      MATCHING_SWEEP_INTERVAL_MS: "0",
      MATCHING_REACTIVE_DISPATCH: "false",
      CIRCUIT_MONITOR_INTERVAL_MS: "0",
      CIRCUIT_STOP_ARRIVAL_RADIUS_METERS: "500",
      TRIP_METER_MAX_GAP_SECONDS: "120",
      FINAL_FARE_MODE: "actual",
      PLACES_PROVIDER: "none",
      JWT_ACCESS_SECRET: randomBytes(48).toString("base64url"),
      JWT_REFRESH_SECRET: randomBytes(48).toString("base64url"),
      WHATSAPP_PROVIDER: "log",
    });

    const { AppModule } = await import("../src/app.module");
    const { configureApp } = await import("../src/app.setup");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PushGateway)
      .useValue(new FakePush())
      .compile();
    app = moduleRef.createNestApplication({ logger: false, rawBody: true });
    configureApp(app);
    await app.init();

    const { UsersService } = await import("../src/modules/users/users.service");
    const { DriversService } =
      await import("../src/modules/drivers/drivers.service");
    const { UserRole } = await import("../src/common/types/user-role.enum");
    const { Vehicle, VehicleType } =
      await import("../src/modules/vehicles/schemas/vehicle.schema");
    const { DriverProfile, DriverStatus } =
      await import("../src/modules/drivers/schemas/driver-profile.schema");
    const { Ride } = await import("../src/modules/rides/schemas/ride.schema");
    const { DriverLocationCheckpoint } =
      await import("../src/modules/locations/schemas/driver-location-checkpoint.schema");
    const { DriverLocationService } =
      await import("../src/modules/locations/driver-location.service");
    const { CircuitMonitorService } =
      await import("../src/modules/circuit-rides/circuit-monitor.service");
    const { Notification } =
      await import("../src/modules/notifications/schemas/notification.schema");

    rideModel = app.get(getModelToken(Ride.name), { strict: false });
    checkpointModel = app.get(getModelToken(DriverLocationCheckpoint.name), {
      strict: false,
    });
    driverModel = app.get(getModelToken(DriverProfile.name), { strict: false });
    notificationModel = app.get(getModelToken(Notification.name), {
      strict: false,
    });
    const locations = app.get(DriverLocationService, { strict: false });
    remember = (id, at) => locations.remember(id, at);
    const monitor = app.get(CircuitMonitorService, { strict: false });
    monitorTick = (now) => monitor.tick(now);

    const users = app.get(UsersService, { strict: false });
    const drivers = app.get(DriversService, { strict: false });
    await users.create({
      phone: PHONES.admin,
      password: PASSWORD,
      role: UserRole.ADMIN,
      firstName: "Ops",
    });
    await users.create({
      phone: PHONES.customer,
      password: PASSWORD,
      role: UserRole.CUSTOMER,
      firstName: "Rahul",
    });
    await users.create({
      phone: PHONES.customer2,
      password: PASSWORD,
      role: UserRole.CUSTOMER,
      firstName: "Meera",
    });
    const driverUser = await users.create({
      phone: PHONES.driver,
      password: PASSWORD,
      role: UserRole.DRIVER,
      firstName: "Rajesh",
      lastName: "Kumar",
    });
    const profile = await drivers.createProfileForUser(
      driverUser._id.toString(),
    );
    driverProfileId = profile._id.toString();
    await driverModel.updateOne(
      { _id: profile._id },
      { $set: { driverStatus: DriverStatus.APPROVED } },
    );
    const vehicleModel = app.get<Model<unknown>>(getModelToken(Vehicle.name), {
      strict: false,
    });
    await vehicleModel.create({
      driverId: profile._id,
      vehicleType: VehicleType.AUTO,
      registrationNumber: "UP85CC0101",
      make: "Bajaj",
      vehicleModel: "RE",
      color: "Green",
      isActive: true,
    });

    for (const who of Object.keys(PHONES) as Who[]) {
      const response = await api()
        .post("/api/v1/auth/login")
        .send({ phone: PHONES[who], password: PASSWORD })
        .expect(200);
      tokens[who] = response.body.data.accessToken as string;
    }
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
    process.chdir(originalCwd);
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  // ── Admin: packages ───────────────────────────────────────────────────

  describe("admin package management", () => {
    it("is admin-only", async () => {
      await api().get(admin()).expect(401);
      for (const who of ["customer", "driver"] as const) {
        await api().get(admin()).set(as(who)).expect(403);
        await api()
          .post(admin())
          .set(as(who))
          .send({ name: "x", city: "y" })
          .expect(403);
        await api().get("/api/v1/admin/circuit-rides").set(as(who)).expect(403);
      }
    });

    it("creates a draft with server-resolved stops, and refuses to publish it incomplete", async () => {
      const draft = (
        await api()
          .post(admin())
          .set(as("admin"))
          .send({
            name: "Vrindavan Spiritual Circuit",
            city: "Vrindavan",
            description: "Three temples",
            stops: STOPS.map((placeId) => ({ placeId })),
          })
          .expect(201)
      ).body.data;
      packageId = draft.id;
      expect(draft).toMatchObject({
        code: "CIR-001",
        status: "DRAFT",
        revision: 1,
        hasBookings: false,
      });
      expect(draft.stops.map((stop: StopView) => stop.order)).toEqual([
        1, 2, 3,
      ]);
      expect(draft.stops[0]).toMatchObject({
        name: "Banke Bihari Temple",
        latitude: 27.5806,
        longitude: 77.7006,
      });
      expect(
        draft.publishProblems.map(
          (problem: { field: string }) => problem.field,
        ),
      ).toEqual(expect.arrayContaining(["pricing", "rideTypes"]));

      const refused = await api()
        .patch(admin(`/${packageId}/status`))
        .set(as("admin"))
        .send({ status: "ACTIVE" })
        .expect(400);
      expect(refused.body.code).toBe("CIRCUIT_PACKAGE_NOT_PUBLISHABLE");
      expect(refused.body.data.problems.length).toBeGreaterThan(0);

      // Unknown places never become stops.
      await api()
        .patch(admin(`/${packageId}`))
        .set(as("admin"))
        .send({
          stops: [{ placeId: "featured:nowhere" }, { placeId: STOPS[0] }],
        })
        .expect(404);
      // Drafts are invisible to customers.
      const listed = (
        await api()
          .get("/api/v1/circuit-packages")
          .set(as("customer"))
          .expect(200)
      ).body.data;
      expect(listed).toEqual([]);
      await api()
        .get(`/api/v1/circuit-packages/${packageId}`)
        .set(as("customer"))
        .expect(404);
    });

    it("previews the stop route and warns when the included distance is too low", async () => {
      const preview = (
        await api()
          .post(admin(`/${packageId}/route-preview`))
          .set(as("admin"))
          .send({ includedDistanceKm: 0.1 })
          .expect(200)
      ).body.data;
      expect(preview.legs).toHaveLength(2);
      expect(preview.stopsDistanceMeters).toBeGreaterThan(100);
      expect(preview.warnings.join(" ")).toContain("lower than");
    });

    it("configures vehicles, a price per vehicle and availability, then publishes", async () => {
      // A price for a vehicle that is not allowed is refused outright.
      await api()
        .patch(admin(`/${packageId}`))
        .set(as("admin"))
        .send({ rideTypes: ["AUTO"], vehiclePricing: [AUTO_PRICE, BIKE_PRICE] })
        .expect(400, /BIKE is priced but not an allowed vehicle/);
      await api()
        .patch(admin(`/${packageId}`))
        .set(as("admin"))
        .send({
          rideTypes: ["AUTO"],
          vehiclePricing: [AUTO_PRICE, { ...AUTO_PRICE, basePrice: 1 }],
        })
        .expect(400, /AUTO is priced twice/);

      // A draft may miss a vehicle's price, but cannot be published like that.
      const partial = (
        await api()
          .patch(admin(`/${packageId}`))
          .set(as("admin"))
          .send({
            pricing: { includedDistanceKm: 30, includedDurationHours: 5 },
            rideTypes: ["AUTO", "BIKE"],
            vehiclePricing: [AUTO_PRICE],
            maxPassengers: 4,
            availability: {
              days: [0, 1, 2, 3, 4, 5, 6],
              opensAt: istClock(-180),
              closesAt: istClock(180),
            },
            cancellationPolicy:
              "Free cancellation before a driver is assigned.",
          })
          .expect(200)
      ).body.data;
      expect(partial.revision).toBe(2);
      expect(partial.pricing).toEqual({
        includedDistanceKm: 30,
        includedDurationHours: 5,
        includedDistanceMeters: 30_000,
        includedDurationSeconds: 18_000,
      });
      expect(
        partial.publishProblems.map(
          (problem: { message: string }) => problem.message,
        ),
      ).toEqual(["Set a price for BIKE"]);
      await api()
        .patch(admin(`/${packageId}/status`))
        .set(as("admin"))
        .send({ status: "ACTIVE" })
        .expect(400, /Set a price for BIKE/);

      // Sent in any order, stored in the allowed vehicles' order.
      const updated = (
        await api()
          .patch(admin(`/${packageId}`))
          .set(as("admin"))
          .send({ vehiclePricing: [BIKE_PRICE, AUTO_PRICE] })
          .expect(200)
      ).body.data;
      expect(updated.revision).toBe(3);
      expect(updated.vehiclePricing).toEqual([AUTO_PRICE, BIKE_PRICE]);
      expect(updated.publishProblems).toEqual([]);

      const active = (
        await api()
          .patch(admin(`/${packageId}/status`))
          .set(as("admin"))
          .send({ status: "ACTIVE", reason: "Launch" })
          .expect(200)
      ).body.data;
      expect(active.status).toBe("ACTIVE");
      expect(active.publishedAt).toBeTruthy();
      // A live package cannot be edited into an unpublishable state.
      await api()
        .patch(admin(`/${packageId}`))
        .set(as("admin"))
        .send({ rideTypes: [] })
        .expect(400, /CIRCUIT_PACKAGE_NOT_PUBLISHABLE/);
      // Illegal status moves are refused.
      await api()
        .patch(admin(`/${packageId}/status`))
        .set(as("admin"))
        .send({ status: "DRAFT" })
        .expect(409);
    });

    it("drops a vehicle's price with the vehicle, and a live package cannot gain an unpriced one", async () => {
      const autoOnly = (
        await api()
          .patch(admin(`/${packageId}`))
          .set(as("admin"))
          .send({ rideTypes: ["AUTO"] })
          .expect(200)
      ).body.data;
      expect(autoOnly.vehiclePricing).toEqual([AUTO_PRICE]);
      await api()
        .patch(admin(`/${packageId}`))
        .set(as("admin"))
        .send({ rideTypes: ["AUTO", "BIKE"] })
        .expect(400, /Set a price for BIKE/);
      const restored = (
        await api()
          .patch(admin(`/${packageId}`))
          .set(as("admin"))
          .send({
            rideTypes: ["AUTO", "BIKE"],
            vehiclePricing: [AUTO_PRICE, BIKE_PRICE],
          })
          .expect(200)
      ).body.data;
      expect(restored.vehiclePricing).toEqual([AUTO_PRICE, BIKE_PRICE]);
    });

    it("moves packages saved with a single price onto every allowed vehicle", async () => {
      const { CircuitPackage } =
        await import("../src/modules/circuit-packages/schemas/circuit-package.schema");
      const { CircuitPackagesService } =
        await import("../src/modules/circuit-packages/circuit-packages.service");
      const packages = app.get<Model<unknown>>(
        getModelToken(CircuitPackage.name),
        { strict: false },
      );
      const { insertedId } = await packages.collection.insertOne({
        code: "CIR-900",
        name: "Legacy circuit",
        description: "",
        city: "Vrindavan",
        status: "INACTIVE",
        stops: [],
        pricing: {
          basePrice: 500,
          includedDistanceMeters: 20_000,
          includedDurationSeconds: 7200,
          extraDistanceRatePerKm: 12,
          extraDurationRatePerHour: 40,
        },
        rideTypes: ["AUTO", "CAB"],
        maxPassengers: 3,
        availability: {
          days: [0, 1, 2, 3, 4, 5, 6],
          opensAt: "06:00",
          closesAt: "20:00",
        },
        revision: 4,
        hasBookings: false,
      });
      const service = app.get(CircuitPackagesService, { strict: false });
      expect(await service.migrateLegacyPricing()).toBe(1);
      expect(await service.migrateLegacyPricing()).toBe(0);

      const migrated = (
        await api()
          .get(admin(`/${insertedId.toString()}`))
          .set(as("admin"))
          .expect(200)
      ).body.data;
      const legacyPrice = {
        basePrice: 500,
        extraDistanceRatePerKm: 12,
        extraDurationRatePerHour: 40,
      };
      expect(migrated.vehiclePricing).toEqual([
        { rideType: "AUTO", ...legacyPrice },
        { rideType: "CAB", ...legacyPrice },
      ]);
      expect(migrated.pricing).toMatchObject({
        includedDistanceMeters: 20_000,
        includedDurationSeconds: 7200,
      });
      expect(migrated.revision).toBe(4);
      const raw = (await packages.collection.findOne({ _id: insertedId })) as {
        pricing: Record<string, unknown>;
      } | null;
      expect(Object.keys(raw!.pricing).sort()).toEqual([
        "includedDistanceMeters",
        "includedDurationSeconds",
      ]);
      await packages.collection.deleteOne({ _id: insertedId });
    });

    it("accepts cover images up to 5 MB and refuses larger ones", async () => {
      /** A PNG whose header says width × height, padded to `bytes` (only the header is probed). */
      const png = (width: number, height: number, bytes: number) => {
        const header = Buffer.alloc(33);
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(
          header,
          0,
        );
        header.writeUInt32BE(13, 8);
        header.write("IHDR", 12, "ascii");
        header.writeUInt32BE(width, 16);
        header.writeUInt32BE(height, 20);
        return Buffer.concat([header, Buffer.alloc(bytes - header.length)]);
      };
      const rule = (
        await api().get(admin("/cover-rule")).set(as("admin")).expect(200)
      ).body.data;
      expect(rule).toMatchObject({
        maxBytes: 5 * 1024 * 1024,
        minWidth: 640,
        minHeight: 360,
      });

      const big = (
        await api()
          .put(admin(`/${packageId}/cover`))
          .set(as("admin"))
          .attach("file", png(1600, 1000, 2 * 1024 * 1024), "cover.png")
          .expect(200)
      ).body.data;
      expect(big.coverPath).toMatch(/\/circuit-packages\/.+\/cover\?v=/);
      await api()
        .put(admin(`/${packageId}/cover`))
        .set(as("admin"))
        .attach("file", png(400, 250, 50_000), "small.png")
        .expect(400, /CIRCUIT_PACKAGE_INVALID_IMAGE/);
      const tooLarge = await api()
        .put(admin(`/${packageId}/cover`))
        .set(as("admin"))
        .attach("file", png(1600, 1000, 6 * 1024 * 1024), "huge.png");
      expect([400, 413]).toContain(tooLarge.status);
      await api()
        .delete(admin(`/${packageId}/cover`))
        .set(as("admin"))
        .expect(200);
    });

    it("records every change in the audit log with old and new values", async () => {
      const audit = (
        await api()
          .get("/api/v1/admin/audit-logs")
          .query({ targetType: "CIRCUIT_PACKAGE", targetId: packageId })
          .set(as("admin"))
          .expect(200)
      ).body.data;
      const actions = audit.items.map((row: { action: string }) => row.action);
      expect(actions).toEqual(
        expect.arrayContaining([
          "circuit_package.create",
          "circuit_package.update",
          "circuit_package.status",
        ]),
      );
      const updates = audit.items.filter(
        (row: { action: string }) => row.action === "circuit_package.update",
      );
      const first = updates.find(
        (row: { metadata: { changes: Record<string, unknown> } }) =>
          row.metadata.changes.pricing,
      );
      expect(first.metadata.changes.pricing.to).toMatchObject({
        includedDistanceMeters: 30_000,
      });
      expect(first.metadata.changes.rideTypes).toEqual({
        from: [],
        to: ["AUTO", "BIKE"],
      });
      expect(first.metadata.changes.vehiclePricing).toEqual({
        from: [],
        to: [AUTO_PRICE],
      });
      const priced = updates.find(
        (row: {
          metadata: {
            changes: { vehiclePricing?: { from: unknown[]; to: unknown[] } };
          };
        }) =>
          row.metadata.changes.vehiclePricing?.from.length === 1 &&
          row.metadata.changes.vehiclePricing.to.length === 2,
      );
      expect(priced.metadata.changes.vehiclePricing.to).toEqual([
        AUTO_PRICE,
        BIKE_PRICE,
      ]);
    });
  });

  // ── Customer: discovery and estimate ──────────────────────────────────

  describe("customer discovery and estimate", () => {
    it("lists the active package with its vehicles capped by real seat capacity", async () => {
      const [pkg] = (
        await api()
          .get("/api/v1/circuit-packages")
          .set(as("customer"))
          .expect(200)
      ).body.data;
      expect(pkg).toMatchObject({
        id: packageId,
        name: "Vrindavan Spiritual Circuit",
        availableNow: true,
        maxPassengers: 3,
      });
      // Cheapest first, each with its own price on the shared allowance.
      expect(
        pkg.vehicles.map((vehicle: { rideType: string }) => vehicle.rideType),
      ).toEqual(["BIKE", "AUTO"]);
      const auto = pkg.vehicles.find(
        (vehicle: { rideType: string }) => vehicle.rideType === "AUTO",
      );
      expect(auto).toMatchObject({
        seatCapacity: 3,
        maxPassengers: 3,
        pricing: {
          basePrice: 600,
          extraDistanceRatePerKm: 15,
          extraDurationRatePerHour: 50,
          includedDistanceMeters: 30_000,
        },
      });
      const bike = pkg.vehicles.find(
        (vehicle: { rideType: string }) => vehicle.rideType === "BIKE",
      );
      expect(bike.pricing).toMatchObject({
        basePrice: 350,
        extraDistanceRatePerKm: 8,
        extraDurationRatePerHour: 30,
        includedDurationSeconds: 18_000,
      });
      expect(pkg.stops.map((stop: StopView) => stop.name)).toEqual([
        "Banke Bihari Temple",
        "Nidhivan",
        "Keshi Ghat",
      ]);
      // The package headline is the "from" price: the cheapest vehicle's.
      expect(pkg.pricing).toMatchObject({
        basePrice: 350,
        includedDistanceMeters: 30_000,
      });
    });

    it("prices the circuit from the pickup on the server, with the chosen vehicle's price", async () => {
      const bike = (
        await api()
          .post(circuit("/estimate"))
          .set(as("customer"))
          .send(estimateBody({ rideType: "BIKE", passengers: 1 }))
          .expect(200)
      ).body.data;
      expect(bike.fare).toMatchObject({
        packagePrice: 350,
        estimatedTotal: 350,
      });
      expect(bike.pricing).toMatchObject({
        basePrice: 350,
        extraDistanceRatePerKm: 8,
        extraDurationRatePerHour: 30,
        includedDistanceMeters: 30_000,
      });

      const estimate = (
        await api()
          .post(circuit("/estimate"))
          .set(as("customer"))
          .send(estimateBody())
          .expect(200)
      ).body.data;
      expect(estimate.fare).toMatchObject({
        packagePrice: 600,
        estimatedTotal: 600,
        isFinal: false,
        currency: "INR",
      });
      expect(estimate.pricing).toMatchObject({
        basePrice: 600,
        extraDistanceRatePerKm: 15,
        extraDurationRatePerHour: 50,
      });
      expect(estimate.route.legs).toHaveLength(3);
      expect(estimate.route.legs[0]).toMatchObject({
        from: PICKUP.address,
        to: "Banke Bihari Temple",
      });
      expect(estimate.route.distanceMeters).toBeGreaterThan(
        estimate.route.pickupLeg.distanceMeters,
      );
      expect(estimate.maxPassengers).toBe(3);
    });

    it("enforces vehicle, capacity and pickup rules", async () => {
      const seats = await api()
        .post(circuit("/estimate"))
        .set(as("customer"))
        .send(estimateBody({ passengers: 4 }))
        .expect(400);
      expect(seats.body).toMatchObject({
        code: "CIRCUIT_PASSENGERS_EXCEEDED",
        data: { maxPassengers: 3 },
      });
      await api()
        .post(circuit("/estimate"))
        .set(as("customer"))
        .send(estimateBody({ rideType: "CAB" }))
        .expect(400, /CIRCUIT_VEHICLE_NOT_ALLOWED/);
      const farAway = {
        address: "Noida Sector 62",
        latitude: 28.627,
        longitude: 77.3725,
      };
      await api()
        .post(circuit("/estimate"))
        .set(as("customer"))
        .send(estimateBody({ pickup: farAway }))
        .expect(400, /CIRCUIT_PICKUP_TOO_FAR/);
      // The client can never send a price, a stop or a distance.
      await api()
        .post(circuit("/estimate"))
        .set(as("customer"))
        .send({ ...estimateBody(), fare: 1 })
        .expect(400);
      await api()
        .post(circuit("/estimate"))
        .set(as("driver"))
        .send(estimateBody())
        .expect(403);
    });

    it("refuses bookings outside operating hours", async () => {
      await api()
        .patch(admin(`/${packageId}`))
        .set(as("admin"))
        .send({
          availability: { opensAt: istClock(120), closesAt: istClock(180) },
        })
        .expect(200);
      const closed = await api()
        .post(circuit("/estimate"))
        .set(as("customer"))
        .send(estimateBody())
        .expect(400);
      expect(closed.body).toMatchObject({
        code: "CIRCUIT_PACKAGE_UNAVAILABLE",
      });
      const [pkg] = (
        await api()
          .get("/api/v1/circuit-packages")
          .set(as("customer"))
          .expect(200)
      ).body.data;
      expect(pkg.availableNow).toBe(false);
      await api()
        .patch(admin(`/${packageId}`))
        .set(as("admin"))
        .send({
          availability: { opensAt: istClock(-180), closesAt: istClock(180) },
        })
        .expect(200);
    });
  });

  // ── Booking → stops → completion ──────────────────────────────────────

  describe("a circuit from booking to payment", () => {
    let rideId: string;

    it("books idempotently and freezes the package on the ride", async () => {
      await goOnline();
      const key = "book-circuit-0001";
      const first = (
        await api()
          .post(circuit())
          .set(as("customer"))
          .set("Idempotency-Key", key)
          .send(estimateBody())
          .expect(201)
      ).body.data as CircuitRide;
      const again = (
        await api()
          .post(circuit())
          .set(as("customer"))
          .set("Idempotency-Key", key)
          .send(estimateBody())
          .expect(201)
      ).body.data as CircuitRide;
      expect(again.id).toBe(first.id);
      expect(await rideModel.countDocuments({ kind: "CIRCUIT" })).toBe(1);
      rideId = first.id;
      expect(first).toMatchObject({
        kind: "CIRCUIT",
        status: "DRIVER_ASSIGNED",
      });
      expect(first.circuit).toMatchObject({
        name: "Vrindavan Spiritual Circuit",
        currentStopOrder: 0,
        pricing: { basePrice: 600 },
      });
      expect(
        first.circuit.stops.every((stop) => stop.status === "UPCOMING"),
      ).toBe(true);
      // Without the key, a second booking is the usual one-active-ride conflict.
      await api()
        .post(circuit())
        .set(as("customer"))
        .send(estimateBody())
        .expect(409, /RIDE_ALREADY_ACTIVE/);
    });

    it("a price change after booking never touches the booking", async () => {
      await api()
        .patch(admin(`/${packageId}`))
        .set(as("admin"))
        .send({
          vehiclePricing: [{ ...AUTO_PRICE, basePrice: 650 }, BIKE_PRICE],
          reason: "Festival pricing",
        })
        .expect(200);
      const ride = (
        await api()
          .get(circuit(`/${rideId}`))
          .set(as("customer"))
          .expect(200)
      ).body.data as CircuitRide;
      expect(ride.circuit.pricing.basePrice).toBe(600);
      expect(ride.fare.estimatedFare).toBe(600);
      const pkg = (
        await api()
          .get(admin(`/${packageId}`))
          .set(as("admin"))
          .expect(200)
      ).body.data;
      expect(pkg.hasBookings).toBe(true);
      // The package moved on; the booking still records the revision it was priced on.
      expect(pkg.revision).toBeGreaterThan(
        (
          (await rideModel.findById(rideId).lean().exec()) as unknown as {
            circuit: { packageRevision: number };
          }
        ).circuit.packageRevision,
      );
      // Used packages are archived, never deleted.
      await api()
        .delete(admin(`/${packageId}`))
        .set(as("admin"))
        .expect(409, /CIRCUIT_PACKAGE_HAS_BOOKINGS/);
    });

    it("the driver starts with the customer's OTP; the first stop becomes current", async () => {
      // The driver sees the package on the offer.
      const offers = (
        await api().get("/api/v1/rides/requests").set(as("driver")).expect(200)
      ).body.data as CircuitRide[];
      expect(offers[0].circuit.stops).toHaveLength(3);
      await api()
        .post(circuit(`/${rideId}/accept`))
        .set(as("driver"))
        .expect(200);
      expect(
        (await driverModel.findById(driverProfileId).lean().exec())!
          .isAvailable,
      ).toBe(false);
      await api()
        .post(circuit(`/${rideId}/arrived`))
        .set(as("driver"))
        .expect(200);
      // No stop commands before the start.
      await stopCommand(rideId, 1, "arrive").expect(409, /CIRCUIT_NOT_STARTED/);
      const otp = (
        (
          await api()
            .get(circuit(`/${rideId}`))
            .set(as("customer"))
            .expect(200)
        ).body.data as CircuitRide
      ).otp!.code;
      const started = (
        await api()
          .post(circuit(`/${rideId}/start`))
          .set(as("driver"))
          .send({ otp })
          .expect(200)
      ).body.data as CircuitRide;
      expect(started.status).toBe("RIDE_STARTED");
      expect(started.circuit).toMatchObject({
        currentStopOrder: 1,
        currentStop: { order: 1, status: "ARRIVING" },
      });
    });

    it("only the backend moves stops: in order, near the stop, arrived before done, repeat-safe", async () => {
      // A circuit is not completed through the normal ride endpoint.
      await api()
        .post(`/api/v1/rides/${rideId}/complete`)
        .set(as("driver"))
        .expect(409, /CIRCUIT_COMPLETE_REQUIRED/);
      await stopCommand(rideId, 2, "arrive").expect(
        409,
        /CIRCUIT_STOP_INVALID/,
      );
      await stopCommand(rideId, 1, "complete").expect(
        409,
        /CIRCUIT_STOP_INVALID/,
      );
      await stopCommand(rideId, 9, "arrive").expect(
        400,
        /CIRCUIT_STOP_INVALID/,
      );
      // Still at the pickup, ~3 km away from stop 1.
      remember(driverProfileId, NEAR_PICKUP);
      const far = await stopCommand(rideId, 1, "arrive").expect(409);
      expect(far.body.code).toBe("CIRCUIT_NOT_AT_STOP");
      // Customers cannot drive the circuit.
      await api()
        .post(circuit(`/${rideId}/stops/1/arrive`))
        .set(as("customer"))
        .expect(403);

      driverAt(0);
      const arrived = (await stopCommand(rideId, 1, "arrive").expect(200)).body
        .data as CircuitRide;
      expect(arrived.circuit.stops[0].status).toBe("ARRIVED");
      // A retry after a lost response changes nothing.
      const retry = (await stopCommand(rideId, 1, "arrive").expect(200)).body
        .data as CircuitRide;
      expect(retry.circuit.stops[0].status).toBe("ARRIVED");

      await stopCommand(rideId, 1, "waiting").expect(200);
      const done = (await stopCommand(rideId, 1, "complete").expect(200)).body
        .data as CircuitRide;
      expect(done.circuit.stops.map((stop) => stop.status)).toEqual([
        "COMPLETED",
        "ARRIVING",
        "UPCOMING",
      ]);
      expect(done.circuit.currentStopOrder).toBe(2);
      await stopCommand(rideId, 1, "complete").expect(200);

      await api()
        .post(circuit(`/${rideId}/complete`))
        .set(as("driver"))
        .expect(409, /CIRCUIT_STOPS_REMAINING/);
    });

    it("a blocked stop stops progress until Admin resolves it", async () => {
      const blocked = (
        await api()
          .post(circuit(`/${rideId}/stops/2/blocked`))
          .set(as("driver"))
          .send({ note: "Lane closed for a procession" })
          .expect(200)
      ).body.data as CircuitRide;
      expect(blocked.circuit.exception).toMatchObject({
        type: "STOP_BLOCKED",
        stopOrder: 2,
      });
      driverAt(1);
      await stopCommand(rideId, 2, "arrive").expect(
        409,
        /CIRCUIT_EXCEPTION_OPEN/,
      );

      const resolved = (
        await api()
          .post(`/api/v1/admin/circuit-rides/${rideId}/exceptions/resolve`)
          .set(as("admin"))
          .send({
            resolution: "SKIP_STOP",
            note: "Called the driver; skipping Nidhivan",
          })
          .expect(200)
      ).body.data;
      expect(
        resolved.ride.circuit.stops.map((stop: StopView) => stop.status),
      ).toEqual(["COMPLETED", "SKIPPED", "ARRIVING"]);
      expect(
        resolved.timeline.map((entry: { type: string }) => entry.type),
      ).toEqual(
        expect.arrayContaining([
          "BOOKED",
          "STOP_ARRIVED",
          "STOP_WAITING",
          "STOP_COMPLETED",
          "STOP_BLOCKED",
          "EXCEPTION_RESOLVED",
        ]),
      );
      await api()
        .post(`/api/v1/admin/circuit-rides/${rideId}/exceptions/resolve`)
        .set(as("admin"))
        .send({ resolution: "CONTINUE", note: "again" })
        .expect(409, /CIRCUIT_NO_EXCEPTION/);
    });

    it("completes on actual usage: 35 km and 6 h on a ₹600 · 30 km · 5 h package is ₹725", async () => {
      driverAt(2);
      await stopCommand(rideId, 3, "arrive").expect(200);
      const last = (await stopCommand(rideId, 3, "complete").expect(200)).body
        .data as CircuitRide;
      expect(last.circuit).toMatchObject({
        readyToComplete: true,
        currentStopOrder: 4,
      });

      // 5 h 59 min plus the seconds the test takes ⇒ 4 extra 15-minute blocks; 34.9 km ⇒ 5 started extra km.
      await driveTrip(rideId, 6 - 1 / 60, 34.9);
      const completed = (
        await api()
          .post(circuit(`/${rideId}/complete`))
          .set(as("driver"))
          .expect(200)
      ).body.data as CircuitRide;
      expect(completed.status).toBe("COMPLETED");
      expect(completed.fare.finalFare).toBe(725);
      expect(completed.fare.final).toMatchObject({
        baseFare: 600,
        distanceCharge: 75,
        timeCharge: 50,
        total: 725,
        distanceSource: "ACTUAL",
      });
      expect(completed.circuit.settlement).toMatchObject({
        extraKm: 5,
        extraBlocks: 4,
        completedBy: "DRIVER",
      });
      expect(completed.paymentStatus).toBe("PENDING");

      // Repeat-safe, and the driver is free again only now.
      const again = (
        await api()
          .post(circuit(`/${rideId}/complete`))
          .set(as("driver"))
          .expect(200)
      ).body.data as CircuitRide;
      expect(again.fare.finalFare).toBe(725);
      const driver = (await driverModel
        .findById(driverProfileId)
        .lean()
        .exec())!;
      expect(driver.isAvailable).toBe(true);
      expect(driver.currentRideId).toBeUndefined();
    });

    it("is paid through the normal payment flow and appears in history as a circuit", async () => {
      const paid = (
        await api()
          .post("/api/v1/payments/cash")
          .set(as("customer"))
          .send({ rideId })
          .expect(200)
      ).body.data;
      expect(paid.amount ?? paid.amountPaise / 100).toBe(725);
      const ride = (
        await api()
          .get(circuit(`/${rideId}`))
          .set(as("customer"))
          .expect(200)
      ).body.data as CircuitRide;
      expect(ride.paymentStatus).toBe("SUCCESS");
      const history = (
        await api().get("/api/v1/rides").set(as("customer")).expect(200)
      ).body.data;
      expect(history.items[0]).toMatchObject({
        id: rideId,
        kind: "CIRCUIT",
        circuit: { name: "Vrindavan Spiritual Circuit" },
      });
    });

    it("notified the customer about stops and the skipped stop", async () => {
      const notifications = await notificationModel
        .find({ rideId: new Types.ObjectId(rideId) })
        .lean()
        .exec();
      const types = notifications.map((row) => row.type);
      expect(types).toEqual(
        expect.arrayContaining([
          "CIRCUIT_STOP",
          "CIRCUIT_EXCEPTION",
          "RIDE_STARTED",
          "RIDE_COMPLETED",
        ]),
      );
    });
  });

  // ── Monitor, end early, admin views ───────────────────────────────────

  describe("monitor warnings and admin intervention", () => {
    let rideId: string;

    it("sends the 30-minute and distance warnings exactly once", async () => {
      const started = await startedCircuit("customer2");
      rideId = started.id;
      // 4 h 35 min into a 5 h package, 25 km of 30 km.
      await driveTrip(rideId, 4 + 35 / 60, 25);
      const first = await monitorTick();
      expect(first).toMatchObject({ checked: 1, warnings: 2 });
      const second = await monitorTick();
      expect(second.warnings).toBe(0);

      const ride = (
        await api()
          .get(circuit(`/${rideId}`))
          .set(as("customer2"))
          .expect(200)
      ).body.data as CircuitRide;
      expect(ride.circuit.usage.distanceMeters).toBeGreaterThan(24_000);
      expect(ride.circuit.usage.elapsedSeconds).toBeGreaterThan(4 * HOUR);
      const warnings = await notificationModel
        .find({ rideId: new Types.ObjectId(rideId), type: "CIRCUIT_WARNING" })
        .lean()
        .exec();
      // Customer and driver, for each of the two warnings.
      expect(warnings).toHaveLength(4);
    });

    it("shows on the live board and in the bookings list", async () => {
      const live = (
        await api()
          .get("/api/v1/admin/circuit-rides/live")
          .set(as("admin"))
          .expect(200)
      ).body.data;
      expect(live.map((item: { id: string }) => item.id)).toEqual([rideId]);
      expect(live[0]).toMatchObject({
        customer: { name: "Meera" },
        driver: { name: "Rajesh Kumar" },
      });
      expect(live[0].driverLocation).toBeDefined();
      const list = (
        await api()
          .get("/api/v1/admin/circuit-rides")
          .query({ status: "RIDE_STARTED" })
          .set(as("admin"))
          .expect(200)
      ).body.data;
      expect(list.total).toBe(1);
      const byPackage = (
        await api()
          .get("/api/v1/admin/circuit-rides")
          .query({ packageId })
          .set(as("admin"))
          .expect(200)
      ).body.data;
      expect(byPackage.total).toBe(2);
    });

    it("Admin ends it early: unfinished stops are skipped and usage is billed", async () => {
      // A started circuit cannot be cancelled, only ended.
      await api()
        .post(`/api/v1/admin/circuit-rides/${rideId}/cancel`)
        .set(as("admin"))
        .send({ reason: "test" })
        .expect(409);
      const ended = (
        await api()
          .post(`/api/v1/admin/circuit-rides/${rideId}/end`)
          .set(as("admin"))
          .send({ reason: "Customer unwell" })
          .expect(200)
      ).body.data;
      expect(ended.ride.status).toBe("COMPLETED");
      expect(
        ended.ride.circuit.stops.every(
          (stop: StopView) => stop.status === "SKIPPED",
        ),
      ).toBe(true);
      expect(ended.ride.circuit).toMatchObject({
        endedEarlyReason: "Customer unwell",
        settlement: { completedBy: "ADMIN" },
      });
      // Booked after the ₹650 price change, within the included time and distance.
      expect(ended.ride.fare.finalFare).toBe(650);
    });

    it("a driver Admin switched off for circuits is never offered one", async () => {
      await api()
        .patch(
          `/api/v1/admin/circuit-rides/drivers/${driverProfileId}/eligibility`,
        )
        .set(as("customer"))
        .send({ eligible: false })
        .expect(403);
      const off = (
        await api()
          .patch(
            `/api/v1/admin/circuit-rides/drivers/${driverProfileId}/eligibility`,
          )
          .set(as("admin"))
          .send({ eligible: false, reason: "Training" })
          .expect(200)
      ).body.data;
      expect(off.circuitEligible).toBe(false);
      await goOnline();
      const booked = (
        await api()
          .post(circuit())
          .set(as("customer"))
          .send(estimateBody())
          .expect(201)
      ).body.data as CircuitRide;
      expect(booked.status).toBe("SEARCHING");
      await api()
        .post(`/api/v1/rides/${booked.id}/cancel`)
        .set(as("customer"))
        .send({})
        .expect(200);

      await api()
        .patch(
          `/api/v1/admin/circuit-rides/drivers/${driverProfileId}/eligibility`,
        )
        .set(as("admin"))
        .send({ eligible: true })
        .expect(200);
      const detail = (
        await api()
          .get(`/api/v1/admin/drivers/${driverProfileId}`)
          .set(as("admin"))
          .expect(200)
      ).body.data;
      expect(detail.driver.circuitEligible).toBe(true);
    });

    it("reports bookings, revenue and package performance", async () => {
      const report = (
        await api()
          .get("/api/v1/admin/circuit-rides/report")
          .set(as("admin"))
          .expect(200)
      ).body.data;
      expect(report.bookings).toMatchObject({
        total: 3,
        completed: 2,
        cancelled: 1,
      });
      expect(report.revenue).toMatchObject({
        gross: 725 + 650,
        extraDistanceRevenue: 75,
        extraTimeRevenue: 50,
      });
      expect(report.packages[0]).toMatchObject({
        packageId,
        bookings: 3,
        completed: 2,
      });
    });
  });
});
