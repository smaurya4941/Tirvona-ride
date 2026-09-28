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

/**
 * Google Routes wiring end to end, with the Routes API replaced by a fake:
 * road distance/duration price the trip, the path is stored on the ride and
 * returned to both apps, the live driver route is served from cache between
 * refreshes, and a provider outage falls back to straight-line estimates.
 * Hermetic: in-memory MongoDB, no network.
 */

const PASSWORD = "Password@123";
const PREM_MANDIR = { address: "Prem Mandir, Vrindavan", latitude: 27.5714, longitude: 77.6716 };
const BANKE_BIHARI = { address: "Banke Bihari Temple, Vrindavan", latitude: 27.5806, longitude: 77.7006 };
const NEAR_PICKUP = { latitude: 27.5725, longitude: 77.677 };
const PHONES = { customer: "+919830000001", stranger: "+919830000002", driver: "+919830000011" };
type Who = keyof typeof PHONES;

interface Point {
  latitude: number;
  longitude: number;
}

/** Stands in for GoogleRoutesEstimator: a fixed road route per call, or a failure. */
class FakeGoogleRoutes {
  calls: Array<{ origin: Point; destination: Point }> = [];
  failWith: Error | null = null;
  readonly isConfigured = true;

  estimate(origin: Point, destination: Point) {
    this.calls.push({ origin, destination });
    if (this.failWith) return Promise.reject(this.failWith);
    return Promise.resolve({
      distanceMeters: 4_321,
      durationSeconds: 777,
      provider: "GOOGLE_ROUTES" as const,
      polyline: `poly-${this.calls.length}`,
    });
  }
}

describe("Google Routes (e2e)", () => {
  const originalCwd = process.cwd();
  let workDir: string;
  let mongo: MongoMemoryServer;
  let app: INestApplication<App>;
  const google = new FakeGoogleRoutes();
  const tokens = {} as Record<Who, string>;
  let rideModel: Model<{ status: string; otpCode?: string; routePolyline?: string; routeProvider: string }>;

  const api = () => request(app.getHttpServer());
  const as = (who: Who) => ({ Authorization: `Bearer ${tokens[who]}` });

  beforeAll(async () => {
    // Generous launch timeout: a busy dev machine can take >10 s to start mongod.
    mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 60_000 } });
    workDir = await mkdtemp(join(tmpdir(), "tirvona-ride-routes-"));
    process.chdir(workDir);
    Object.assign(process.env, {
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      SWAGGER_ENABLED: "false",
      MONGODB_URI: mongo.getUri(),
      MONGODB_DB_NAME: "tirvona_ride_routes",
      REDIS_URL: "",
      THROTTLE_LIMIT: "5000",
      THROTTLE_AUTH_LIMIT: "1000",
      THROTTLE_OTP_SEND_LIMIT: "1000",
      THROTTLE_OTP_VERIFY_LIMIT: "1000",
      THROTTLE_REFRESH_LIMIT: "1000",
      THROTTLE_ADMIN_LOGIN_LIMIT: "1000",
      THROTTLE_PROMO_LIMIT: "1000",
      BROADCAST_WORKER_INTERVAL_MS: "0",
      JWT_ACCESS_SECRET: randomBytes(48).toString("base64url"),
      JWT_REFRESH_SECRET: randomBytes(48).toString("base64url"),
      MATCHING_SWEEP_INTERVAL_MS: "0",
      MATCHING_REACTIVE_DISPATCH: "true",
      ROUTES_PROVIDER: "google",
      GOOGLE_ROUTES_API_KEY: "fake-key-never-sent",
      ROUTES_FAILURE_THRESHOLD: "2",
      ROUTES_FAILURE_COOLDOWN_SECONDS: "600",
    });

    const { AppModule } = await import("../src/app.module");
    const { configureApp } = await import("../src/app.setup");
    const { GoogleRoutesEstimator } = await import("../src/modules/locations/google-routes-estimator");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(GoogleRoutesEstimator)
      .useValue(google)
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    configureApp(app);
    await app.init();

    const { UsersService } = await import("../src/modules/users/users.service");
    const { DriversService } = await import("../src/modules/drivers/drivers.service");
    const { UserRole } = await import("../src/common/types/user-role.enum");
    const { Vehicle, VehicleType } = await import("../src/modules/vehicles/schemas/vehicle.schema");
    const { DriverProfile, DriverStatus } = await import("../src/modules/drivers/schemas/driver-profile.schema");
    const { Ride } = await import("../src/modules/rides/schemas/ride.schema");

    rideModel = app.get(getModelToken(Ride.name), { strict: false });
    const driverModel = app.get<Model<unknown>>(getModelToken(DriverProfile.name), { strict: false });
    const vehicleModel = app.get<Model<unknown>>(getModelToken(Vehicle.name), { strict: false });
    const users = app.get(UsersService, { strict: false });
    const drivers = app.get(DriversService, { strict: false });

    for (const key of ["customer", "stranger"] as const)
      await users.create({ phone: PHONES[key], password: PASSWORD, role: UserRole.CUSTOMER, firstName: key });
    const driverUser = await users.create({
      phone: PHONES.driver,
      password: PASSWORD,
      role: UserRole.DRIVER,
      firstName: "Route",
      lastName: "Driver",
    });
    const profile = await drivers.createProfileForUser(driverUser._id.toString());
    await driverModel.updateOne({ _id: profile._id }, { $set: { driverStatus: DriverStatus.APPROVED } });
    await vehicleModel.create({
      driverId: profile._id,
      vehicleType: VehicleType.AUTO,
      registrationNumber: "UP85RT0001",
      make: "Bajaj",
      vehicleModel: "RE",
      color: "Green",
      isActive: true,
    });

    for (const key of Object.keys(PHONES) as Who[]) {
      const response = await api().post("/api/v1/auth/login").send({ phone: PHONES[key], password: PASSWORD }).expect(200);
      tokens[key] = response.body.data.accessToken as string;
    }
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
    process.chdir(originalCwd);
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  let rideId: string;

  it("prices estimates on the road route and returns its path", async () => {
    const response = await api()
      .post("/api/v1/rides/estimate/all")
      .set(as("customer"))
      .send({ pickup: PREM_MANDIR, destination: BANKE_BIHARI })
      .expect(200);
    const estimates = response.body.data as Array<Record<string, unknown>>;
    expect(estimates.length).toBeGreaterThan(0);
    for (const estimate of estimates)
      expect(estimate).toMatchObject({
        distanceMeters: 4_321,
        durationSeconds: 777,
        routeProvider: "GOOGLE_ROUTES",
        routePolyline: "poly-1",
      });
    expect(google.calls).toHaveLength(1);
    expect(google.calls[0]).toMatchObject({
      origin: { latitude: PREM_MANDIR.latitude, longitude: PREM_MANDIR.longitude },
      destination: { latitude: BANKE_BIHARI.latitude, longitude: BANKE_BIHARI.longitude },
    });
  });

  it("books on the cached route (no second Google call) and stores the path on the ride", async () => {
    await api()
      .patch("/api/v1/drivers/availability")
      .set(as("driver"))
      .send({ isOnline: true, ...NEAR_PICKUP })
      .expect(200);
    const response = await api()
      .post("/api/v1/rides")
      .set(as("customer"))
      .send({ rideType: "AUTO", pickup: PREM_MANDIR, destination: BANKE_BIHARI })
      .expect(201);
    rideId = response.body.data.id as string;
    expect(response.body.data).toMatchObject({ routeProvider: "GOOGLE_ROUTES", routePolyline: "poly-1", distanceMeters: 4_321 });
    expect(google.calls).toHaveLength(1);
    expect(await rideModel.findById(rideId).lean()).toMatchObject({ routePolyline: "poly-1" });
  });

  it("has no live route before the driver accepts", async () => {
    const response = await api().get(`/api/v1/rides/${rideId}/route`).set(as("customer")).expect(200);
    expect(response.body.data).toBeNull();
  });

  it("after accept: driver → pickup route for both apps, served from cache between refreshes", async () => {
    // Reactive dispatch offers the ride to the only driver.
    for (let i = 0; i < 50 && (await rideModel.findById(rideId).lean())?.status !== "DRIVER_ASSIGNED"; i += 1)
      await new Promise((resolve) => setTimeout(resolve, 50));
    await api().post(`/api/v1/rides/${rideId}/accept`).set(as("driver")).expect(200);

    const forCustomer = await api().get(`/api/v1/rides/${rideId}/route`).set(as("customer")).expect(200);
    expect(forCustomer.body.data).toMatchObject({
      rideId,
      stage: "APPROACH",
      origin: NEAR_PICKUP,
      destination: { latitude: PREM_MANDIR.latitude, longitude: PREM_MANDIR.longitude },
      provider: "GOOGLE_ROUTES",
      polyline: "poly-2",
      durationSeconds: 777,
    });
    const forDriver = await api().get(`/api/v1/rides/${rideId}/route`).set(as("driver")).expect(200);
    expect(forDriver.body.data).toMatchObject({ stage: "APPROACH", polyline: "poly-2" });
    expect(google.calls).toHaveLength(2);
    expect(google.calls[1].origin).toEqual(NEAR_PICKUP);
  });

  it("only the ride's own customer and driver can read it", async () => {
    const response = await api().get(`/api/v1/rides/${rideId}/route`).set(as("stranger")).expect(404);
    expect(response.body.code).toBe("RIDE_NOT_FOUND");
    await api().get(`/api/v1/rides/${rideId}/route`).expect(401);
  });

  it("no route while waiting at the pickup; driver → destination once the trip starts", async () => {
    await api().post(`/api/v1/rides/${rideId}/arrived`).set(as("driver")).expect(200);
    const waiting = await api().get(`/api/v1/rides/${rideId}/route`).set(as("customer")).expect(200);
    expect(waiting.body.data).toBeNull();

    const { otpCode } = (await rideModel.findById(rideId).select("+otpCode").lean()) ?? {};
    await api().post(`/api/v1/rides/${rideId}/start`).set(as("driver")).send({ otp: otpCode }).expect(200);

    const trip = await api().get(`/api/v1/rides/${rideId}/route`).set(as("customer")).expect(200);
    expect(trip.body.data).toMatchObject({
      stage: "TRIP",
      destination: { latitude: BANKE_BIHARI.latitude, longitude: BANKE_BIHARI.longitude },
      polyline: "poly-3",
    });
  });

  it("a Google outage falls back to straight-line estimates, then stops calling Google", async () => {
    const { RouteProviderError } = await import("../src/modules/locations/route-estimator");
    google.failWith = new RouteProviderError("Google Routes 503 UNAVAILABLE", true);
    const callsBefore = google.calls.length;
    const trip = (latitude: number) => ({
      pickup: { ...PREM_MANDIR, latitude },
      destination: BANKE_BIHARI,
    });

    for (const latitude of [27.561, 27.562, 27.563]) {
      const response = await api().post("/api/v1/rides/estimate/all").set(as("stranger")).send(trip(latitude)).expect(200);
      const [estimate] = response.body.data as Array<Record<string, unknown>>;
      expect(estimate.routeProvider).toBe("HAVERSINE");
      expect(estimate.routePolyline).toBeUndefined();
      expect(estimate.distanceMeters).toBeGreaterThan(0);
    }
    // Threshold 2: the third estimate never reached Google.
    expect(google.calls.length - callsBefore).toBe(2);
  });
});
