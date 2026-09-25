import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { getModelToken } from "@nestjs/mongoose";
import { Test } from "@nestjs/testing";
import { MongoMemoryServer } from "mongodb-memory-server";
import type { Model } from "mongoose";
import request from "supertest";
import type { App } from "supertest/types";
// Type-only: the real modules load after the env is prepared (see beforeAll).
import type * as Geo from "../src/modules/locations/geo";
import type * as FareCalculator from "../src/modules/pricing/fare-calculator";

/**
 * Phase 2 "definition of done" against the real HTTP surface: book → match →
 * accept → arrive → OTP → start → complete, plus every rule the plan lists
 * (fare authority, state machine, OTP gate, race safety, busy drivers,
 * availability after completion, history, admin inspection and pricing).
 *
 * Hermetic like the Phase 1 suite; the background sweep is disabled so the
 * test drives dispatch deterministically via RideDispatchService.sweep().
 */

const PASSWORD = "Password@123";

// Vrindavan test geography.
const PREM_MANDIR = { address: "Prem Mandir, Vrindavan", latitude: 27.5714, longitude: 77.6716 };
const BANKE_BIHARI = { address: "Banke Bihari Temple, Vrindavan", latitude: 27.5806, longitude: 77.7006 };
const NEAR_PICKUP = { latitude: 27.5725, longitude: 77.677 }; // ISKCON, ~0.6 km
const FAR_FROM_PICKUP = { latitude: 27.5829, longitude: 77.6987 }; // Nidhivan, ~3 km
const AT_PICKUP = { latitude: 27.5716, longitude: 77.6717 };

const PHONES = {
  admin: "+919810000000",
  customerA: "+919810000001",
  customerB: "+919810000002",
  customerC: "+919810000003",
  autoNear: "+919810000011",
  autoFar: "+919810000012",
  bike: "+919810000013",
  pendingDriver: "+919810000014",
};

describe("Phase 2 — basic ride booking (e2e)", () => {
  const originalCwd = process.cwd();
  let workDir: string;
  let mongo: MongoMemoryServer;
  let app: INestApplication<App>;
  const tokens: Record<keyof typeof PHONES, string> = {} as never;
  const driverProfileIds: Partial<Record<keyof typeof PHONES, string>> = {};

  // Resolved after the app boots (dynamic imports keep module load after env setup).
  let rideModel: Model<{ status: string; searchExpiresAt: Date; assignmentExpiresAt?: Date; rejectedDriverIds: unknown[] }>;
  let driverModel: Model<{ lastSeenAt?: Date; locationUpdatedAt?: Date }>;
  let sweep: () => Promise<void>;
  let calculateFare: typeof FareCalculator.calculateFare;
  let haversineMeters: typeof Geo.haversineMeters;

  const api = () => request(app.getHttpServer());
  const as = (who: keyof typeof PHONES) => ({ Authorization: `Bearer ${tokens[who]}` });
  const trip = (rideType: string, pickup = PREM_MANDIR, destination = BANKE_BIHARI) => ({
    rideType,
    pickup,
    destination,
  });

  async function login(phone: string): Promise<string> {
    const response = await api().post("/api/v1/auth/login").send({ phone, password: PASSWORD }).expect(200);
    return response.body.data.accessToken as string;
  }

  async function goOnline(who: keyof typeof PHONES, at: { latitude: number; longitude: number }) {
    return api().patch("/api/v1/drivers/availability").set(as(who)).send({ isOnline: true, ...at });
  }

  async function rideAs(who: keyof typeof PHONES, rideId: string) {
    return (await api().get(`/api/v1/rides/${rideId}`).set(as(who)).expect(200)).body.data;
  }

  async function requestsOf(who: keyof typeof PHONES) {
    return (await api().get("/api/v1/rides/requests").set(as(who)).expect(200)).body.data as Array<Record<string, unknown>>;
  }

  async function dashboardOf(who: keyof typeof PHONES) {
    return (await api().get("/api/v1/drivers/dashboard").set(as(who)).expect(200)).body.data;
  }

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    workDir = await mkdtemp(join(tmpdir(), "tirvona-ride-e2e2-"));
    process.chdir(workDir);
    Object.assign(process.env, {
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      SWAGGER_ENABLED: "false",
      MONGODB_URI: mongo.getUri(),
      MONGODB_DB_NAME: "tirvona_ride_phase2",
      REDIS_URL: "",
      THROTTLE_LIMIT: "5000",
      JWT_ACCESS_SECRET: randomBytes(48).toString("base64url"),
      JWT_REFRESH_SECRET: randomBytes(48).toString("base64url"),
      MATCHING_SWEEP_INTERVAL_MS: "0",
      // Phase 2 drives dispatch by hand; Phase 3 reactive timers are covered in phase3.e2e-spec.ts.
      MATCHING_REACTIVE_DISPATCH: "false",
    });

    const { AppModule } = await import("../src/app.module");
    const { configureApp } = await import("../src/app.setup");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    configureApp(app);
    await app.init();

    ({ calculateFare } = await import("../src/modules/pricing/fare-calculator"));
    ({ haversineMeters } = await import("../src/modules/locations/geo"));
    const { UsersService } = await import("../src/modules/users/users.service");
    const { DriversService } = await import("../src/modules/drivers/drivers.service");
    const { UserRole } = await import("../src/common/types/user-role.enum");
    const { Vehicle, VehicleType } = await import("../src/modules/vehicles/schemas/vehicle.schema");
    const { DriverProfile, DriverStatus } = await import("../src/modules/drivers/schemas/driver-profile.schema");
    const { Ride } = await import("../src/modules/rides/schemas/ride.schema");
    const { RideDispatchService } = await import("../src/modules/rides/ride-dispatch.service");

    rideModel = app.get(getModelToken(Ride.name), { strict: false });
    driverModel = app.get(getModelToken(DriverProfile.name), { strict: false });
    const vehicleModel = app.get<Model<unknown>>(getModelToken(Vehicle.name), { strict: false });
    const dispatch = app.get(RideDispatchService, { strict: false });
    sweep = () => dispatch.sweep();

    const users = app.get(UsersService, { strict: false });
    const drivers = app.get(DriversService, { strict: false });

    await users.create({ phone: PHONES.admin, password: PASSWORD, role: UserRole.ADMIN, firstName: "Ops" });
    for (const key of ["customerA", "customerB", "customerC"] as const)
      await users.create({ phone: PHONES[key], password: PASSWORD, role: UserRole.CUSTOMER, firstName: key });

    // Phase 1 already proves KYC onboarding end to end; here drivers are
    // provisioned directly as approved with one active vehicle each.
    const fleet = [
      ["autoNear", VehicleType.AUTO, "UP85AA0001", DriverStatus.APPROVED],
      ["autoFar", VehicleType.AUTO, "UP85AA0002", DriverStatus.APPROVED],
      ["bike", VehicleType.BIKE, "UP85AA0003", DriverStatus.APPROVED],
      ["pendingDriver", VehicleType.AUTO, "UP85AA0004", DriverStatus.UNDER_REVIEW],
    ] as const;
    for (const [key, vehicleType, registrationNumber, status] of fleet) {
      const user = await users.create({ phone: PHONES[key], password: PASSWORD, role: UserRole.DRIVER, firstName: key, lastName: "Driver" });
      const profile = await drivers.createProfileForUser(user._id.toString());
      await driverModel.updateOne({ _id: profile._id }, { $set: { driverStatus: status } });
      await vehicleModel.create({ driverId: profile._id, vehicleType, registrationNumber, make: "Bajaj", vehicleModel: "RE", color: "Green", isActive: true });
      driverProfileIds[key] = profile._id.toString();
    }

    for (const key of Object.keys(PHONES) as Array<keyof typeof PHONES>) tokens[key] = await login(PHONES[key]);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
    process.chdir(originalCwd);
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  let rideOne: string;
  let rideOneEstimate: number;

  describe("Ride types, pricing and estimates", () => {
    it("seeds Bike, Auto and Cab", async () => {
      const response = await api().get("/api/v1/ride-types").set(as("customerA")).expect(200);
      expect(response.body.data.map((type: { code: string }) => type.code)).toEqual(["BIKE", "AUTO", "CAB"]);
    });

    it("prices an estimate on the server with the active tariff", async () => {
      const response = await api().post("/api/v1/rides/estimate").set(as("customerA")).send(trip("AUTO")).expect(200);
      const estimate = response.body.data;

      const distanceMeters = Math.round(haversineMeters(PREM_MANDIR, BANKE_BIHARI));
      const durationSeconds = Math.max(60, Math.round(distanceMeters / (22_000 / 3600)));
      const expected = calculateFare(
        { currency: "INR", baseFare: 30, perKmRate: 10, perMinuteRate: 1.5, minimumFare: 40 },
        distanceMeters,
        durationSeconds,
      );
      expect(estimate).toMatchObject({
        rideType: "AUTO",
        distanceMeters,
        durationSeconds,
        routeProvider: "HAVERSINE",
        fare: {
          baseFare: 30,
          distanceCharge: expected.distanceCharge,
          timeCharge: expected.timeCharge,
          minimumFare: 40,
          estimatedFare: expected.total,
        },
      });
      rideOneEstimate = expected.total;
    });

    it("estimates every ride type from one route", async () => {
      const response = await api()
        .post("/api/v1/rides/estimate/all")
        .set(as("customerA"))
        .send({ pickup: PREM_MANDIR, destination: BANKE_BIHARI })
        .expect(200);
      expect(response.body.data.map((estimate: { rideType: string }) => estimate.rideType)).toEqual(["BIKE", "AUTO", "CAB"]);
    });

    it("rejects bad trips and non-customers", async () => {
      const same = await api().post("/api/v1/rides/estimate").set(as("customerA")).send(trip("AUTO", PREM_MANDIR, PREM_MANDIR)).expect(400);
      expect(same.body.code).toBe("RIDE_TOO_SHORT");
      await api().post("/api/v1/rides/estimate").set(as("customerA")).send(trip("AUTO", { ...PREM_MANDIR, latitude: 123 })).expect(400);
      await api().post("/api/v1/rides/estimate").set(as("customerA")).send(trip("TRUCK")).expect(400);
      await api().post("/api/v1/rides/estimate").set(as("autoNear")).send(trip("AUTO")).expect(403);
      await api().post("/api/v1/rides/estimate").send(trip("AUTO")).expect(401);
    });
  });

  describe("Driver availability", () => {
    it("keeps unapproved drivers offline", async () => {
      const response = await goOnline("pendingDriver", NEAR_PICKUP);
      expect(response.status).toBe(403);
      expect(response.body.code).toBe("DRIVER_NOT_APPROVED");
    });

    it("requires a location the first time", async () => {
      const response = await api().patch("/api/v1/drivers/availability").set(as("autoNear")).send({ isOnline: true }).expect(400);
      expect(response.body.code).toBe("DRIVER_LOCATION_REQUIRED");
    });

    it("puts approved drivers online and available", async () => {
      const response = await goOnline("autoNear", NEAR_PICKUP);
      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({ isOnline: true, isAvailable: true, vehicle: { vehicleType: "AUTO" } });
      await goOnline("autoFar", FAR_FROM_PICKUP).then((r) => expect(r.status).toBe(200));
      await goOnline("bike", AT_PICKUP).then((r) => expect(r.status).toBe(200));
    });
  });

  describe("Booking, matching and the driver lifecycle", () => {
    it("never accepts a client-supplied fare", async () => {
      await api().post("/api/v1/rides").set(as("customerA")).send({ ...trip("AUTO"), estimatedFare: 1 }).expect(400);
    });

    it("books an Auto and assigns the nearest Auto driver (not the nearer bike)", async () => {
      const response = await api().post("/api/v1/rides").set(as("customerA")).send(trip("AUTO")).expect(201);
      const ride = response.body.data;
      rideOne = ride.id;
      expect(ride).toMatchObject({ status: "DRIVER_ASSIGNED", rideType: "AUTO", fare: { estimatedFare: rideOneEstimate } });
      expect(ride.rideCode).toMatch(/^TR[2-9A-Z]{8}$/);
      expect(ride.driver).toMatchObject({ name: "autoNear Driver", vehicle: { registrationNumber: "UP85AA0001" } });
      expect(ride.otp).toBeUndefined();
    });

    it("rejects a second active ride for the same customer", async () => {
      const response = await api().post("/api/v1/rides").set(as("customerA")).send(trip("AUTO")).expect(409);
      expect(response.body).toMatchObject({ code: "RIDE_ALREADY_ACTIVE", data: { rideId: rideOne } });
    });

    it("shows the request only to the assigned driver", async () => {
      const [request] = await requestsOf("autoNear");
      expect(request).toMatchObject({ id: rideOne, status: "DRIVER_ASSIGNED", customer: { name: "customerA" } });
      expect(request.pickupDistanceMeters).toBeGreaterThan(0);
      expect(request.otp).toBeUndefined();
      expect((request.customer as { phone?: string }).phone).toBeUndefined();
      expect(await requestsOf("autoFar")).toEqual([]);
      expect(await requestsOf("bike")).toEqual([]);
    });

    it("rejects unauthorized actions", async () => {
      await api().post(`/api/v1/rides/${rideOne}/accept`).set(as("customerA")).expect(403);
      const stranger = await api().post(`/api/v1/rides/${rideOne}/accept`).set(as("autoFar")).expect(409);
      expect(stranger.body.code).toBe("RIDE_STATE_CONFLICT");
      await api().get(`/api/v1/rides/${rideOne}`).set(as("autoFar")).expect(404);
      await api().get(`/api/v1/rides/${rideOne}`).set(as("customerB")).expect(404);
      await api().get("/api/v1/admin/rides").set(as("customerA")).expect(403);
    });

    it("re-matches to the next driver when the assigned driver rejects", async () => {
      await api().post(`/api/v1/rides/${rideOne}/reject`).set(as("autoNear")).send({ reason: "Too far" }).expect(200);
      expect((await dashboardOf("autoNear")).isAvailable).toBe(true);
      expect(await requestsOf("autoNear")).toEqual([]);

      const [request] = await requestsOf("autoFar");
      expect(request).toMatchObject({ id: rideOne, status: "DRIVER_ASSIGNED" });
      expect((await rideAs("customerA", rideOne)).driver.name).toBe("autoFar Driver");
    });

    it("lets exactly one of several concurrent accepts win", async () => {
      const results = await Promise.all([
        api().post(`/api/v1/rides/${rideOne}/accept`).set(as("autoFar")),
        api().post(`/api/v1/rides/${rideOne}/accept`).set(as("autoFar")),
        api().post(`/api/v1/rides/${rideOne}/accept`).set(as("autoNear")),
      ]);
      expect(results.filter((result) => result.status === 200)).toHaveLength(1);
      expect(results.filter((result) => result.status === 409)).toHaveLength(2);
      const ride = await rideAs("autoFar", rideOne);
      expect(ride.status).toBe("DRIVER_ACCEPTED");
      expect(ride.customer.phone).toBe(PHONES.customerA);
    });

    it("never offers a new ride to a busy driver", async () => {
      // autoFar is busy with rideOne; autoNear goes offline → no Auto free.
      await api().patch("/api/v1/drivers/availability").set(as("autoNear")).send({ isOnline: false }).expect(200);
      const booked = await api().post("/api/v1/rides").set(as("customerB")).send(trip("AUTO")).expect(201);
      expect(booked.body.data.status).toBe("SEARCHING");
      await sweep();
      expect(await requestsOf("autoFar")).toEqual([]);
      expect((await rideAs("customerB", booked.body.data.id)).status).toBe("SEARCHING");

      // A free Auto appears → the next sweep assigns it.
      await goOnline("autoNear", NEAR_PICKUP).then((r) => expect(r.status).toBe(200));
      await sweep();
      expect((await rideAs("customerB", booked.body.data.id)).status).toBe("DRIVER_ASSIGNED");

      const cancelled = await api()
        .post(`/api/v1/rides/${booked.body.data.id}/cancel`)
        .set(as("customerB"))
        .send({ reason: "Plans changed" })
        .expect(200);
      expect(cancelled.body.data).toMatchObject({
        status: "CANCELLED",
        cancellation: { cancelledBy: "CUSTOMER", reason: "Plans changed" },
      });
      expect((await dashboardOf("autoNear")).isAvailable).toBe(true);
    });

    it("rejects out-of-order transitions", async () => {
      const start = await api().post(`/api/v1/rides/${rideOne}/start`).set(as("autoFar")).send({ otp: "0000" }).expect(409);
      expect(start.body).toMatchObject({ code: "INVALID_STATUS_TRANSITION", data: { currentStatus: "DRIVER_ACCEPTED" } });
      await api().post(`/api/v1/rides/${rideOne}/complete`).set(as("autoFar")).expect(409);
      const offline = await api().patch("/api/v1/drivers/availability").set(as("autoFar")).send({ isOnline: false }).expect(409);
      expect(offline.body.code).toBe("DRIVER_HAS_ACTIVE_RIDE");
    });

    let otp: string;

    it("issues the OTP on arrival — to the customer only", async () => {
      expect((await rideAs("customerA", rideOne)).otp).toBeUndefined();
      const arrived = await api().post(`/api/v1/rides/${rideOne}/arrived`).set(as("autoFar")).expect(200);
      expect(arrived.body.data.status).toBe("DRIVER_ARRIVED");
      expect(arrived.body.data.otp).toBeUndefined();

      const customerView = await rideAs("customerA", rideOne);
      expect(customerView.status).toBe("DRIVER_ARRIVED");
      expect(customerView.otp.code).toMatch(/^\d{4}$/);
      otp = customerView.otp.code;
      expect((await rideAs("autoFar", rideOne)).otp).toBeUndefined();
    });

    it("rejects a wrong OTP and keeps the ride at DRIVER_ARRIVED", async () => {
      const wrong = otp === "1234" ? "4321" : "1234";
      const response = await api().post(`/api/v1/rides/${rideOne}/start`).set(as("autoFar")).send({ otp: wrong }).expect(400);
      expect(response.body).toMatchObject({ code: "RIDE_OTP_INVALID", data: { attemptsRemaining: 4 } });
      expect((await rideAs("customerA", rideOne)).status).toBe("DRIVER_ARRIVED");
    });

    it("starts only with the correct OTP, which is then single-use", async () => {
      const started = await api().post(`/api/v1/rides/${rideOne}/start`).set(as("autoFar")).send({ otp }).expect(200);
      expect(started.body.data.status).toBe("RIDE_STARTED");
      await api().post(`/api/v1/rides/${rideOne}/start`).set(as("autoFar")).send({ otp }).expect(409);
      const customerView = await rideAs("customerA", rideOne);
      expect(customerView.status).toBe("RIDE_STARTED");
      expect(customerView.otp).toBeUndefined();
      const cancel = await api().post(`/api/v1/rides/${rideOne}/cancel`).set(as("customerA")).send({}).expect(409);
      expect(cancel.body.code).toBe("RIDE_NOT_CANCELLABLE");
    });

    it("completes with the final fare and frees the driver", async () => {
      const completed = await api().post(`/api/v1/rides/${rideOne}/complete`).set(as("autoFar")).expect(200);
      expect(completed.body.data).toMatchObject({ status: "COMPLETED", fare: { finalFare: rideOneEstimate } });

      const dashboard = await dashboardOf("autoFar");
      expect(dashboard).toMatchObject({
        isOnline: true,
        isAvailable: true,
        totalRides: 1,
        currentRide: null,
        today: { completedRides: 1, grossFares: rideOneEstimate },
      });
      expect((await rideAs("customerA", rideOne)).status).toBe("COMPLETED");
    });

    it("records the ride in both histories", async () => {
      const customerHistory = (await api().get("/api/v1/rides").set(as("customerA")).expect(200)).body.data;
      expect(customerHistory.items.map((ride: { id: string }) => ride.id)).toContain(rideOne);
      const driverHistory = (await api().get("/api/v1/rides").set(as("autoFar")).expect(200)).body.data;
      expect(driverHistory.items[0]).toMatchObject({ id: rideOne, status: "COMPLETED" });
      // autoNear was only offered (and rejected) rideOne — it is not theirs.
      const rejecterHistory = (await api().get("/api/v1/rides").set(as("autoNear")).expect(200)).body.data;
      expect(rejecterHistory.items.map((ride: { id: string }) => ride.id)).not.toContain(rideOne);
      // Customer can book again once the previous ride is done.
      expect((await api().get("/api/v1/rides/active").set(as("customerA")).expect(200)).body.data).toBeNull();
    });
  });

  describe("Timeouts and heartbeats", () => {
    it("ends a search with NO_DRIVER_AVAILABLE", async () => {
      const booked = await api().post("/api/v1/rides").set(as("customerC")).send(trip("CAB")).expect(201);
      expect(booked.body.data.status).toBe("SEARCHING");
      await rideModel.updateOne({ _id: booked.body.data.id }, { $set: { searchExpiresAt: new Date(Date.now() - 1000) } });
      await sweep();
      expect((await rideAs("customerC", booked.body.data.id)).status).toBe("NO_DRIVER_AVAILABLE");
    });

    it("skips drivers with a stale location and re-matches ignored requests", async () => {
      // Bike driver's GPS went quiet 10 minutes ago (Phase 3: freshness = location).
      await driverModel.updateOne(
        { _id: driverProfileIds.bike },
        { $set: { locationUpdatedAt: new Date(Date.now() - 600_000) } },
      );
      const booked = await api().post("/api/v1/rides").set(as("customerC")).send(trip("BIKE")).expect(201);
      const rideId = booked.body.data.id as string;
      expect(booked.body.data.status).toBe("SEARCHING");

      // The app sends a location again → next sweep assigns it.
      await api().patch("/api/v1/drivers/location").set(as("bike")).send(NEAR_PICKUP).expect(200);
      await sweep();
      expect((await rideAs("customerC", rideId)).status).toBe("DRIVER_ASSIGNED");

      // Driver ignores it past the acceptance window.
      await rideModel.updateOne({ _id: rideId }, { $set: { assignmentExpiresAt: new Date(Date.now() - 1000) } });
      const late = await api().post(`/api/v1/rides/${rideId}/accept`).set(as("bike")).expect(409);
      expect(late.body.code).toBe("RIDE_STATE_CONFLICT");
      const ride = await rideModel.findById(rideId).lean();
      expect(ride?.status).toBe("SEARCHING");
      expect(ride?.rejectedDriverIds.map(String)).toContain(driverProfileIds.bike);
      expect((await dashboardOf("bike")).isAvailable).toBe(true);

      await api().post(`/api/v1/rides/${rideId}/cancel`).set(as("customerC")).send({ reason: "Took too long" }).expect(200);
    });
  });

  describe("Admin", () => {
    it("lists and filters rides", async () => {
      const response = await api().get("/api/v1/admin/rides").query({ status: "COMPLETED" }).set(as("admin")).expect(200);
      expect(response.body.data.total).toBe(1);
      expect(response.body.data.items[0]).toMatchObject({
        id: rideOne,
        customer: { name: "customerA", phone: PHONES.customerA },
        driver: { name: "autoFar Driver" },
      });
      const all = await api().get("/api/v1/admin/rides").set(as("admin")).expect(200);
      expect(all.body.data.total).toBe(4);
    });

    it("shows the full ride detail and status history", async () => {
      const detail = (await api().get(`/api/v1/admin/rides/${rideOne}`).set(as("admin")).expect(200)).body.data;
      expect(detail.history.map((entry: { toStatus: string }) => entry.toStatus)).toEqual([
        "SEARCHING",
        "DRIVER_ASSIGNED",
        "SEARCHING",
        "DRIVER_ASSIGNED",
        "DRIVER_ACCEPTED",
        "DRIVER_ARRIVED",
        "RIDE_STARTED",
        "COMPLETED",
      ]);
      expect(detail.history[2]).toMatchObject({ actorType: "DRIVER", actorName: "autoNear Driver" });
      expect(detail.ride).toMatchObject({
        status: "COMPLETED",
        otp: { issued: true, attempts: 1 },
        fare: { estimatedFare: rideOneEstimate, finalFare: rideOneEstimate },
      });
      for (const field of ["requestedAt", "assignedAt", "acceptedAt", "arrivedAt", "startedAt", "completedAt"])
        expect(detail.ride[field]).toEqual(expect.any(String));
      expect(detail.ride.otp.code).toBeUndefined();
    });

    it("changes pricing for new estimates only", async () => {
      const rows = (await api().get("/api/v1/admin/pricing").set(as("admin")).expect(200)).body.data;
      expect(rows.map((row: { rideType: { code: string } }) => row.rideType.code)).toEqual(["BIKE", "AUTO", "CAB"]);

      await api().patch("/api/v1/admin/pricing/AUTO").set(as("admin")).send({ baseFare: -5 }).expect(400);
      await api().patch("/api/v1/admin/pricing/AUTO").set(as("admin")).send({ perKmRate: 10.555 }).expect(400);
      await api().patch("/api/v1/admin/pricing/AUTO").set(as("customerA")).send({ baseFare: 1 }).expect(403);
      const updated = await api().patch("/api/v1/admin/pricing/AUTO").set(as("admin")).send({ baseFare: 50 }).expect(200);
      expect(updated.body.data).toMatchObject({ baseFare: 50, version: 2 });

      const estimate = (await api().post("/api/v1/rides/estimate").set(as("customerA")).send(trip("AUTO")).expect(200)).body.data;
      expect(estimate.fare.baseFare).toBe(50);
      expect(estimate.fare.estimatedFare).toBe(rideOneEstimate + 20);
      // The completed ride keeps the tariff it was booked under.
      expect((await rideAs("customerA", rideOne)).fare.baseFare).toBe(30);
    });

    it("can switch a ride type off", async () => {
      await api().patch("/api/v1/admin/ride-types/CAB").set(as("admin")).send({ isActive: false }).expect(200);
      const response = await api().post("/api/v1/rides/estimate").set(as("customerA")).send(trip("CAB")).expect(400);
      expect(response.body.code).toBe("RIDE_TYPE_INACTIVE");
      const types = (await api().get("/api/v1/ride-types").set(as("customerA")).expect(200)).body.data;
      expect(types.map((type: { code: string }) => type.code)).toEqual(["BIKE", "AUTO"]);
      await api().patch("/api/v1/admin/ride-types/CAB").set(as("admin")).send({ isActive: true }).expect(200);
    });

    it("reports ride counts on the dashboard", async () => {
      const dashboard = (await api().get("/api/v1/admin/dashboard").set(as("admin")).expect(200)).body.data;
      expect(dashboard.rides).toMatchObject({ activeRides: 0, completedToday: 1, cancelledToday: 2, noDriverToday: 1 });
    });
  });
});
