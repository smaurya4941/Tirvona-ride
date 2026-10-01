import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { ModulesContainer } from "@nestjs/core";
import { getModelToken } from "@nestjs/mongoose";
import { Test } from "@nestjs/testing";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Types } from "mongoose";
import type { Model } from "mongoose";
import request from "supertest";
import type { App } from "supertest/types";
import { PushGateway } from "../src/modules/notifications/push/push.gateway";
import type { PushMessage, PushResult } from "../src/modules/notifications/push/push.gateway";

/**
 * Phase 7 "definition of done": authorization audit and permission matrix,
 * ownership, validation, rate limits, ride types, zones, promo codes,
 * cancellation reasons/fees, broadcasts, reports reconciliation, admin
 * customer/driver actions with an audit trail, and matching rules.
 */

const PASSWORD = "Password@123";
const PREM_MANDIR = { address: "Prem Mandir, Vrindavan", latitude: 27.5714, longitude: 77.6716 };
const BANKE_BIHARI = { address: "Banke Bihari Temple, Vrindavan", latitude: 27.5806, longitude: 77.7006 };
const NEAR_PICKUP = { latitude: 27.5725, longitude: 77.677 };
const NOIDA = { address: "Sector 62, Noida", latitude: 28.6271, longitude: 77.3716 };
const NOIDA_DEST = { address: "Sector 18, Noida", latitude: 28.5708, longitude: 77.3261 };

const PHONES = {
  admin: "+919870000000",
  customerA: "+919870000001",
  customerB: "+919870000002",
  driverA: "+919870000011",
  driverB: "+919870000012",
  pendingDriver: "+919870000013",
};
type Who = keyof typeof PHONES;

class FakePush extends PushGateway {
  readonly isConfigured = true;
  readonly sent: Array<{ token: string; message: PushMessage }> = [];
  async send(tokens: string[], message: PushMessage): Promise<PushResult[]> {
    return tokens.map((token) => {
      this.sent.push({ token, message });
      return { token, delivered: true, tokenInvalid: false };
    });
  }
}

/** Routes that may be called without a token. Adding one must be deliberate. */
const EXPECTED_PUBLIC_ROUTES = [
  "POST /auth/register",
  "POST /auth/login",
  "POST /auth/refresh",
  "POST /auth/logout",
  "POST /auth/verify-otp",
  "POST /auth/resend-otp",
  // Forgot password: the user cannot sign in, by definition.
  "POST /auth/password/forgot",
  "POST /auth/password/verify-otp",
  "POST /auth/password/reset",
  // Login with a WhatsApp code instead of the password.
  "POST /auth/login/otp/request",
  "POST /auth/login/otp/verify",
  "POST /admin/auth/login",
  "POST /payments/webhook",
  "POST /payments/webhook/razorpay",
  // Branding: the apps show the logo/splash before sign-in.
  "GET /branding",
  "GET /branding/assets/:kind",
  // Popular-place photos: rendered with a plain image request; admin-published only.
  "GET /places/popular/:id/image",
].sort();

const HTTP_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "ALL", "OPTIONS", "HEAD", "SEARCH"];

describe("Phase 7 — admin completion & hardening (e2e)", () => {
  const originalCwd = process.cwd();
  let workDir: string;
  let mongo: MongoMemoryServer;
  let app: INestApplication<App>;
  const push = new FakePush();
  const tokens = {} as Record<Who, string>;
  const userIds = {} as Record<Who, string>;
  const driverIds = {} as Record<Who, string>;
  let settle: () => Promise<void>;
  let drainBroadcasts: () => Promise<void>;
  let runDueBroadcasts: () => Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const models = {} as Record<string, Model<any>>;

  const api = () => request(app.getHttpServer());
  const as = (who: Who) => ({ Authorization: `Bearer ${tokens[who]}` });
  const trip = (rideType = "AUTO", pickup: object = PREM_MANDIR, destination: object = BANKE_BIHARI) => ({
    rideType,
    pickup,
    destination,
  });

  async function login(who: Who) {
    const response = await api().post("/api/v1/auth/login").send({ phone: PHONES[who], password: PASSWORD }).expect(200);
    tokens[who] = response.body.data.accessToken as string;
    userIds[who] = response.body.data.user.id as string;
  }

  async function goOnline(who: Who = "driverA") {
    await api().patch("/api/v1/drivers/availability").set(as(who)).send({ isOnline: true, ...NEAR_PICKUP }).expect(200);
  }

  async function book(customer: Who, body: object = trip()) {
    const response = await api().post("/api/v1/rides").set(as(customer)).send(body).expect(201);
    return response.body.data as {
      id: string;
      rideCode: string;
      status: string;
      fare: { estimatedFare: number; discount?: number; payableFare?: number };
      promo?: { code: string; discount: number };
      zone?: { name: string };
    };
  }

  async function accept(rideId: string, driver: Who = "driverA") {
    await api().post(`/api/v1/rides/${rideId}/accept`).set(as(driver)).expect(200);
  }

  async function startTrip(rideId: string, customer: Who, driver: Who = "driverA") {
    await api().post(`/api/v1/rides/${rideId}/arrived`).set(as(driver)).expect(200);
    const otp = (await api().get(`/api/v1/rides/${rideId}`).set(as(customer)).expect(200)).body.data.otp.code;
    await api().post(`/api/v1/rides/${rideId}/start`).set(as(driver)).send({ otp }).expect(200);
  }

  async function completedRide(customer: Who, body: object = trip()) {
    await goOnline();
    const ride = await book(customer, body);
    expect(ride.status).toBe("DRIVER_ASSIGNED");
    await accept(ride.id);
    await startTrip(ride.id, customer);
    const done = await api().post(`/api/v1/rides/${ride.id}/complete`).set(as("driverA")).expect(200);
    return { ...ride, completed: done.body.data };
  }

  async function payCash(customer: Who, rideId: string) {
    return (await api().post("/api/v1/payments/cash").set(as(customer)).send({ rideId }).expect(200)).body.data;
  }

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    workDir = await mkdtemp(join(tmpdir(), "tirvona-ride-e2e7-"));
    process.chdir(workDir);
    Object.assign(process.env, {
      NODE_ENV: "test",
      // Older suites assert final fare = estimate; actual-trip pricing is in payments-v2.
      FINAL_FARE_MODE: "booked",
      LOG_LEVEL: "silent",
      SWAGGER_ENABLED: "false",
      MONGODB_URI: mongo.getUri(),
      MONGODB_DB_NAME: "tirvona_ride_phase7",
      REDIS_URL: "",
      THROTTLE_LIMIT: "5000",
      THROTTLE_AUTH_LIMIT: "1000",
      THROTTLE_REFRESH_LIMIT: "1000",
      THROTTLE_OTP_VERIFY_LIMIT: "1000",
      THROTTLE_PROMO_LIMIT: "1000",
      // Deliberately strict, to prove the per-route limits bite.
      THROTTLE_OTP_SEND_LIMIT: "2",
      THROTTLE_ADMIN_LOGIN_LIMIT: "3",
      JWT_ACCESS_SECRET: randomBytes(48).toString("base64url"),
      JWT_REFRESH_SECRET: randomBytes(48).toString("base64url"),
      MATCHING_SWEEP_INTERVAL_MS: "0",
      MATCHING_REACTIVE_DISPATCH: "true",
      PAYMENT_RECONCILE_INTERVAL_MS: "0",
      BROADCAST_WORKER_INTERVAL_MS: "0",
      BROADCAST_BATCH_SIZE: "1",
    });

    const { AppModule } = await import("../src/app.module");
    const { configureApp } = await import("../src/app.setup");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PushGateway)
      .useValue(push)
      .compile();
    app = moduleRef.createNestApplication({ logger: false, rawBody: true });
    configureApp(app);
    await app.init();

    const { DomainEventsService } = await import("../src/infrastructure/events/domain-events.service");
    const { NotificationsService } = await import("../src/modules/notifications/notifications.service");
    const { BroadcastsService } = await import("../src/modules/notifications/broadcasts/broadcasts.service");
    const events = app.get(DomainEventsService);
    const notifications = app.get(NotificationsService, { strict: false });
    const broadcasts = app.get(BroadcastsService, { strict: false });
    settle = async () => {
      for (let round = 0; round < 3; round += 1) {
        await events.drain();
        await notifications.drain();
      }
    };
    drainBroadcasts = async () => {
      await broadcasts.drain();
      await settle();
    };
    runDueBroadcasts = () => broadcasts.runDue();

    const { Ride } = await import("../src/modules/rides/schemas/ride.schema");
    const { Payment } = await import("../src/modules/payments/schemas/payment.schema");
    const { DriverEarning } = await import("../src/modules/earnings/schemas/driver-earning.schema");
    const { Cancellation } = await import("../src/modules/cancellations/schemas/cancellation.schemas");
    const { PromoCode, PromoRedemption } = await import("../src/modules/promotions/schemas/promo-code.schema");
    const { Broadcast } = await import("../src/modules/notifications/broadcasts/broadcast.schema");
    const { DriverProfile, DriverStatus } = await import("../src/modules/drivers/schemas/driver-profile.schema");
    const { Vehicle, VehicleType } = await import("../src/modules/vehicles/schemas/vehicle.schema");
    for (const [key, name] of Object.entries({
      ride: Ride.name,
      payment: Payment.name,
      earning: DriverEarning.name,
      cancellation: Cancellation.name,
      promo: PromoCode.name,
      redemption: PromoRedemption.name,
      broadcast: Broadcast.name,
      driver: DriverProfile.name,
      vehicle: Vehicle.name,
    }))
      models[key] = app.get(getModelToken(name), { strict: false });

    const { UsersService } = await import("../src/modules/users/users.service");
    const { DriversService } = await import("../src/modules/drivers/drivers.service");
    const { UserRole } = await import("../src/common/types/user-role.enum");
    const users = app.get(UsersService, { strict: false });
    const drivers = app.get(DriversService, { strict: false });

    await users.create({ phone: PHONES.admin, password: PASSWORD, role: UserRole.ADMIN, firstName: "Ops" });
    await users.create({ phone: PHONES.customerA, password: PASSWORD, role: UserRole.CUSTOMER, firstName: "Sachin" });
    await users.create({ phone: PHONES.customerB, password: PASSWORD, role: UserRole.CUSTOMER, firstName: "Meera" });
    for (const [who, plate] of [
      ["driverA", "UP85CC7001"],
      ["driverB", "UP85CC7002"],
    ] as const) {
      const user = await users.create({ phone: PHONES[who], password: PASSWORD, role: UserRole.DRIVER, firstName: who });
      const profile = await drivers.createProfileForUser(user._id.toString());
      await models.driver.updateOne({ _id: profile._id }, { $set: { driverStatus: DriverStatus.APPROVED } });
      await models.vehicle.create({ driverId: profile._id, vehicleType: VehicleType.AUTO, registrationNumber: plate, isActive: true });
      driverIds[who] = profile._id.toString();
    }
    const pending = await users.create({ phone: PHONES.pendingDriver, password: PASSWORD, role: UserRole.DRIVER, firstName: "Kishan" });
    driverIds.pendingDriver = (await drivers.createProfileForUser(pending._id.toString()))._id.toString();

    for (const who of Object.keys(PHONES) as Who[]) await login(who);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
    process.chdir(originalCwd);
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  // ── Authorization audit (route metadata) ─────────────────────────────

  describe("Authorization audit", () => {
    const routes: Array<{ route: string; isPublic: boolean; roles?: string[] }> = [];

    beforeAll(async () => {
      const { IS_PUBLIC_KEY } = await import("../src/common/decorators/public.decorator");
      const { ROLES_KEY } = await import("../src/common/decorators/roles.decorator");
      const seen = new Set<unknown>();
      for (const module of app.get(ModulesContainer).values()) {
        for (const wrapper of module.controllers.values()) {
          const controller = wrapper.metatype as (new (...args: unknown[]) => unknown) | null;
          if (!controller || seen.has(controller)) continue;
          seen.add(controller);
          const base = String(Reflect.getMetadata("path", controller) ?? "").replace(/^\/|\/$/g, "");
          const classPublic = Reflect.getMetadata(IS_PUBLIC_KEY, controller) === true;
          const classRoles = Reflect.getMetadata(ROLES_KEY, controller) as string[] | undefined;
          for (const name of Object.getOwnPropertyNames(controller.prototype)) {
            const handler = (controller.prototype as Record<string, unknown>)[name];
            if (name === "constructor" || typeof handler !== "function") continue;
            const methodIndex = Reflect.getMetadata("method", handler) as number | undefined;
            if (methodIndex === undefined) continue;
            const path = String(Reflect.getMetadata("path", handler) ?? "").replace(/^\/|\/$/g, "");
            routes.push({
              route: `${HTTP_METHODS[methodIndex]} /${[base, path].filter(Boolean).join("/")}`,
              isPublic: classPublic || Reflect.getMetadata(IS_PUBLIC_KEY, handler) === true,
              roles: (Reflect.getMetadata(ROLES_KEY, handler) as string[] | undefined) ?? classRoles,
            });
          }
        }
      }
    });

    it("discovers the whole HTTP surface", () => {
      expect(routes.length).toBeGreaterThan(100);
    });

    it("keeps every /admin route ADMIN-only (except admin sign-in)", () => {
      const offenders = routes.filter(
        (entry) =>
          entry.route.includes(" /admin/") &&
          entry.route !== "POST /admin/auth/login" &&
          (entry.isPublic || JSON.stringify(entry.roles) !== JSON.stringify(["ADMIN"])),
      );
      expect(offenders).toEqual([]);
    });

    it("exposes only the expected unauthenticated routes (health and share pages aside)", () => {
      const publicRoutes = routes
        .filter((entry) => entry.isPublic && !/ \/health|\/shared-rides/.test(entry.route))
        .map((entry) => entry.route)
        .sort();
      expect(publicRoutes).toEqual(EXPECTED_PUBLIC_ROUTES);
    });

    it("never lets an ADMIN role onto customer or driver ride actions", () => {
      const rideActions = routes.filter((entry) => /^POST \/rides\/:id\/(accept|reject|arrived|start|complete)$/.test(entry.route));
      expect(rideActions).toHaveLength(5);
      for (const entry of rideActions) expect(entry.roles).toEqual(["DRIVER"]);
      expect(routes.find((entry) => entry.route === "POST /rides")?.roles).toEqual(["CUSTOMER"]);
    });
  });

  // ── Permission matrix & ownership ────────────────────────────────────

  describe("Permission matrix", () => {
    it.each([
      ["GET", "/api/v1/admin/dashboard"],
      ["GET", "/api/v1/admin/customers"],
      ["GET", "/api/v1/admin/reports/overview"],
      ["GET", "/api/v1/admin/promotions"],
      ["GET", "/api/v1/admin/zones"],
      ["GET", "/api/v1/admin/broadcasts"],
      ["GET", "/api/v1/admin/audit-logs"],
      ["GET", "/api/v1/admin/ride-types"],
    ])("%s %s: admin 200, customer 403, driver 403, anonymous 401", async (_method, path) => {
      await api().get(path).set(as("admin")).expect(200);
      expect((await api().get(path).set(as("customerA")).expect(403)).body.code).toBe("AUTH_FORBIDDEN");
      await api().get(path).set(as("driverA")).expect(403);
      await api().get(path).expect(401);
    });

    it("keeps customers off driver endpoints and drivers off customer endpoints", async () => {
      await api().get("/api/v1/rides/requests").set(as("customerA")).expect(403);
      await api().get("/api/v1/earnings").set(as("customerA")).expect(403);
      await api().post("/api/v1/rides").set(as("driverA")).send(trip()).expect(403);
      await api().post("/api/v1/promotions/validate").set(as("driverA")).send({ ...trip(), code: "ANY" }).expect(403);
      await api().post("/api/v1/rides").set(as("admin")).send(trip()).expect(403);
    });

    it("requires an APPROVED driver for driver ride APIs", async () => {
      const response = await api().get("/api/v1/rides/requests").set(as("pendingDriver")).expect(403);
      expect(response.body.code).toBe("DRIVER_NOT_APPROVED");
    });

    it("enforces ownership: other customers and other drivers see nothing", async () => {
      await goOnline();
      const ride = await book("customerA");
      await api().get(`/api/v1/rides/${ride.id}`).set(as("customerB")).expect(404);
      await api().get(`/api/v1/rides/${ride.id}/cancellation`).set(as("customerB")).expect(404);
      await api().post(`/api/v1/rides/${ride.id}/cancel`).set(as("customerB")).send({ reasonCode: "CHANGED_MIND" }).expect(404);
      // Driver B was never offered this ride.
      await api().post(`/api/v1/rides/${ride.id}/accept`).set(as("driverB")).expect(409);
      await api().get(`/api/v1/rides/${ride.id}`).set(as("driverB")).expect(404);
      await api().post(`/api/v1/rides/${ride.id}/cancel`).set(as("customerA")).send({ reasonCode: "CHANGED_MIND" }).expect(200);
    });
  });

  // ── Validation ───────────────────────────────────────────────────────

  describe("Input validation", () => {
    it("rejects unexpected fields, bad ids, coordinates, enums and ranges", async () => {
      const extra = await api().post("/api/v1/rides/estimate").set(as("customerA")).send({ ...trip(), fare: 1 }).expect(400);
      expect(extra.body.errors.join(" ")).toContain("property fare should not exist");
      await api().get("/api/v1/rides/not-an-id").set(as("customerA")).expect(400);
      await api().get("/api/v1/admin/drivers/123").set(as("admin")).expect(400);
      await api().post("/api/v1/rides/estimate").set(as("customerA")).send(trip("AUTO", { ...PREM_MANDIR, longitude: 200 })).expect(400);
      await api().get("/api/v1/admin/customers?limit=500").set(as("admin")).expect(400);
      await api().get("/api/v1/admin/drivers?status=SLEEPING").set(as("admin")).expect(400);
      await api().get("/api/v1/admin/reports/rides?from=2026-13-01&to=2026-13-02").set(as("admin")).expect(400);
      await api()
        .post("/api/v1/admin/promotions")
        .set(as("admin"))
        .send({ code: "x", title: "t", discountType: "PERCENTAGE", discountValue: 120, startsAt: "nope", endsAt: "nope" })
        .expect(400);
    });
  });

  // ── Rate limiting ────────────────────────────────────────────────────

  describe("Rate limiting", () => {
    it("limits OTP sends per client (THROTTLE_OTP_SEND_LIMIT)", async () => {
      // The per-IP throttle runs before the handler: unknown sign-ups still
      // spend the budget (OtpService adds its own per-number limits).
      const resend = (phone: string) =>
        api().post("/api/v1/auth/resend-otp").send({ phone, verificationId: "x".repeat(43) });
      await resend("+919870000091").expect(400);
      await resend("+919870000092").expect(400);
      await resend("+919870000093").expect(429);
      // Other routes have their own budget.
      await api().post("/api/v1/auth/login").send({ phone: PHONES.customerA, password: PASSWORD }).expect(200);
    });

    it("admits only admins at /admin/auth/login and throttles it hardest", async () => {
      const ok = await api().post("/api/v1/admin/auth/login").send({ phone: PHONES.admin, password: PASSWORD }).expect(200);
      expect(ok.body.data.user.role).toBe("ADMIN");
      const customer = await api().post("/api/v1/admin/auth/login").send({ phone: PHONES.customerA, password: PASSWORD }).expect(401);
      const wrong = await api().post("/api/v1/admin/auth/login").send({ phone: PHONES.admin, password: "Wrong@1234" }).expect(401);
      // A customer account learns nothing beyond "wrong credentials".
      expect(customer.body.code).toBe("AUTH_INVALID_CREDENTIALS");
      expect(customer.body.message).toBe(wrong.body.message);
      await api().post("/api/v1/admin/auth/login").send({ phone: PHONES.admin, password: PASSWORD }).expect(429);
    });

    it("does not throttle ordinary authenticated reads at the auth limits", async () => {
      for (let index = 0; index < 8; index += 1) await api().get("/api/v1/admin/zones").set(as("admin")).expect(200);
    });
  });

  // ── Ride types ───────────────────────────────────────────────────────

  describe("Ride types", () => {
    it("seeds E_RICKSHAW switched off and without a tariff", async () => {
      const rows = (await api().get("/api/v1/admin/ride-types").set(as("admin")).expect(200)).body.data;
      expect(rows.map((row: { rideType: { code: string } }) => row.rideType.code)).toEqual(["BIKE", "AUTO", "E_RICKSHAW", "CAB"]);
      const rickshaw = rows.find((row: { rideType: { code: string } }) => row.rideType.code === "E_RICKSHAW");
      expect(rickshaw).toMatchObject({ rideType: { isActive: false, vehicleType: "E_RICKSHAW" }, pricing: null });
    });

    it("refuses to activate a ride type until it has a tariff", async () => {
      const refused = await api().patch("/api/v1/admin/ride-types/E_RICKSHAW").set(as("admin")).send({ isActive: true }).expect(400);
      expect(refused.body.code).toBe("RIDE_TYPE_PRICING_REQUIRED");
      const partial = await api().patch("/api/v1/admin/pricing/E_RICKSHAW").set(as("admin")).send({ baseFare: 15 }).expect(400);
      expect(partial.body.code).toBe("PRICING_NOT_CONFIGURED");
      const tariff = await api()
        .patch("/api/v1/admin/pricing/E_RICKSHAW")
        .set(as("admin"))
        .send({ baseFare: 15, perKmRate: 8, perMinuteRate: 1, minimumFare: 25 })
        .expect(200);
      expect(tariff.body.data).toMatchObject({ rideType: "E_RICKSHAW", version: 1 });
      await api().patch("/api/v1/admin/ride-types/E_RICKSHAW").set(as("admin")).send({ isActive: true }).expect(200);
      const bookable = (await api().get("/api/v1/ride-types").set(as("customerA")).expect(200)).body.data;
      expect(bookable.map((type: { code: string }) => type.code)).toContain("E_RICKSHAW");
    });

    it("creates a new product on an existing vehicle type, and deactivates without deleting", async () => {
      await api()
        .post("/api/v1/admin/ride-types")
        .set(as("admin"))
        .send({ code: "AUTO_SHARE", displayName: "Auto Share", icon: "auto", vehicleType: "AUTO", seatCapacity: 3, isActive: true })
        .expect(400);
      const created = await api()
        .post("/api/v1/admin/ride-types")
        .set(as("admin"))
        .send({
          code: "AUTO_SHARE",
          displayName: "Auto Share",
          icon: "auto",
          vehicleType: "AUTO",
          seatCapacity: 3,
          isActive: true,
          pricing: { baseFare: 20, perKmRate: 7, perMinuteRate: 1, minimumFare: 30 },
        })
        .expect(201);
      expect(created.body.data).toMatchObject({ rideType: { code: "AUTO_SHARE", isActive: true }, pricing: { version: 1 } });
      await api()
        .post("/api/v1/admin/ride-types")
        .set(as("admin"))
        .send({ code: "AUTO_SHARE", displayName: "Again", icon: "auto", vehicleType: "AUTO", seatCapacity: 3 })
        .expect(409);

      const estimates = (await api().post("/api/v1/rides/estimate/all").set(as("customerA")).send({ pickup: PREM_MANDIR, destination: BANKE_BIHARI }).expect(200)).body.data;
      expect(estimates.map((estimate: { rideType: string }) => estimate.rideType)).toContain("AUTO_SHARE");

      await api().patch("/api/v1/admin/ride-types/AUTO_SHARE").set(as("admin")).send({ isActive: false, reason: "Pilot ended" }).expect(200);
      const inactive = await api().post("/api/v1/rides/estimate").set(as("customerA")).send(trip("AUTO_SHARE")).expect(400);
      expect(inactive.body.code).toBe("RIDE_TYPE_INACTIVE");
      await api().delete("/api/v1/admin/ride-types/AUTO_SHARE").set(as("admin")).expect(404);
      const audit = (await api().get("/api/v1/admin/audit-logs?targetType=RIDE_TYPE").set(as("admin")).expect(200)).body.data.items;
      expect(audit.map((entry: { action: string }) => entry.action)).toEqual(
        expect.arrayContaining(["ride_type.create", "ride_type.deactivate", "ride_type.activate"]),
      );
    });
  });

  // ── Zones ────────────────────────────────────────────────────────────

  describe("Zones", () => {
    let zoneId: string;

    it("rejects an invalid boundary", async () => {
      const bowTie = [
        { latitude: 27.5, longitude: 77.6 },
        { latitude: 27.7, longitude: 77.8 },
        { latitude: 27.5, longitude: 77.8 },
        { latitude: 27.7, longitude: 77.6 },
      ];
      const response = await api().post("/api/v1/admin/zones").set(as("admin")).send({ name: "Broken", boundary: bowTie }).expect(400);
      expect(response.body.code).toBe("ZONE_INVALID_BOUNDARY");
    });

    it("creates a zone; bookings inside it are tagged, pickups outside are refused", async () => {
      const { circlePoints } = await import("../src/modules/zones/zone-geometry");
      const created = await api()
        .post("/api/v1/admin/zones")
        .set(as("admin"))
        .send({ name: "Vrindavan", city: "Mathura", boundary: circlePoints(PREM_MANDIR, 8) })
        .expect(201);
      zoneId = created.body.data.id;
      expect(created.body.data).toMatchObject({ name: "Vrindavan", status: "ACTIVE", vertexCount: 48 });
      await api().post("/api/v1/admin/zones").set(as("admin")).send({ name: "vrindavan", boundary: circlePoints(NOIDA, 2) }).expect(409);

      const lookup = await api().get(`/api/v1/admin/zones/lookup?latitude=${NOIDA.latitude}&longitude=${NOIDA.longitude}`).set(as("admin")).expect(200);
      expect(lookup.body.data).toEqual({ serviceable: false, zone: null });

      const outside = await api().post("/api/v1/rides/estimate").set(as("customerA")).send(trip("AUTO", NOIDA, NOIDA_DEST)).expect(400);
      expect(outside.body.code).toBe("SERVICE_AREA_UNAVAILABLE");

      await goOnline();
      const ride = await book("customerA");
      expect(ride.zone).toMatchObject({ name: "Vrindavan" });
      await api().post(`/api/v1/rides/${ride.id}/cancel`).set(as("customerA")).send({ reasonCode: "BOOKED_BY_MISTAKE" }).expect(200);
    });

    it("needs a reason to deactivate; with no active zone, Tirvona serves everywhere again", async () => {
      await api().patch(`/api/v1/admin/zones/${zoneId}/status`).set(as("admin")).send({ status: "INACTIVE" }).expect(400);
      await api().patch(`/api/v1/admin/zones/${zoneId}/status`).set(as("admin")).send({ status: "INACTIVE", reason: "Testing" }).expect(200);
      await api().post("/api/v1/rides/estimate").set(as("customerA")).send(trip("AUTO", NOIDA, NOIDA_DEST)).expect(200);
      await api().patch(`/api/v1/admin/zones/${zoneId}/status`).set(as("admin")).send({ status: "ACTIVE" }).expect(200);
    });
  });

  // ── Promo codes ──────────────────────────────────────────────────────

  describe("Promo codes", () => {
    let promoId: string;
    const now = Date.now();
    const promoBody = {
      code: "braj20",
      title: "₹20 off",
      discountType: "FLAT",
      discountValue: 20,
      minRideValue: 30,
      usageLimit: 2,
      perUserLimit: 1,
      startsAt: new Date(now - 3_600_000).toISOString(),
      endsAt: new Date(now + 86_400_000).toISOString(),
      applicableRideTypes: ["AUTO"],
      showInApp: true,
    };

    it("admin creates a promo (code normalised to upper case)", async () => {
      const created = await api().post("/api/v1/admin/promotions").set(as("admin")).send(promoBody).expect(201);
      promoId = created.body.data.id;
      expect(created.body.data).toMatchObject({ code: "BRAJ20", isLive: true, usedCount: 0 });
      await api().post("/api/v1/admin/promotions").set(as("admin")).send(promoBody).expect(409);
      const offers = (await api().get("/api/v1/promotions").set(as("customerA")).expect(200)).body.data;
      expect(offers.map((offer: { code: string }) => offer.code)).toContain("BRAJ20");
    });

    it("validates on the server: unknown, wrong ride type, eligible", async () => {
      const unknown = await api().post("/api/v1/promotions/validate").set(as("customerA")).send({ ...trip(), code: "NOPE99" }).expect(404);
      expect(unknown.body.code).toBe("PROMO_INVALID");
      const wrongType = await api().post("/api/v1/promotions/validate").set(as("customerA")).send({ ...trip("BIKE"), code: "BRAJ20" }).expect(400);
      expect(wrongType.body.code).toBe("PROMO_RIDE_TYPE_NOT_ELIGIBLE");
      const quote = (await api().post("/api/v1/promotions/validate").set(as("customerA")).send({ ...trip(), code: "braj20" }).expect(200)).body.data;
      expect(quote).toMatchObject({ code: "BRAJ20", discount: 20, payableFare: quote.fare - 20 });
    });

    it("checks a code before a trip is chosen (Offers screen)", async () => {
      const saved = (await api().post("/api/v1/promotions/check").set(as("customerA")).send({ code: " braj20 " }).expect(200)).body.data;
      expect(saved).toMatchObject({ code: "BRAJ20", discountType: "FLAT", discountValue: 20, applicableRideTypes: ["AUTO"] });
      expect(saved.usedCount).toBeUndefined();
      const unknown = await api().post("/api/v1/promotions/check").set(as("customerA")).send({ code: "NOPE99" }).expect(404);
      expect(unknown.body.code).toBe("PROMO_INVALID");
      await api().post("/api/v1/promotions/check").set(as("customerA")).send({ code: "X" }).expect(400);
      await api().post("/api/v1/promotions/check").set(as("driverA")).send({ code: "BRAJ20" }).expect(403);
    });

    it("books with the promo, charges fare − discount, credits the driver on the full fare", async () => {
      const ride = await completedRide("customerA", { ...trip(), promoCode: "BRAJ20" });
      expect(ride.promo).toMatchObject({ code: "BRAJ20", discount: 20 });
      expect(ride.fare.payableFare).toBe(ride.fare.estimatedFare - 20);
      expect(ride.completed.fare).toMatchObject({ discount: 20, payableFare: ride.completed.fare.finalFare - 20 });

      const payment = await payCash("customerA", ride.id);
      expect(payment.amount).toBe(ride.completed.fare.finalFare - 20);
      await settle();

      const earning = await models.earning.findOne({ rideId: new Types.ObjectId(ride.id) }).lean();
      expect(earning.grossFarePaise).toBe(ride.completed.fare.finalFare * 100);
      expect(earning.promoDiscountPaise).toBe(2000);
      const redemption = await models.redemption.findOne({ rideId: new Types.ObjectId(ride.id) }).lean();
      expect(redemption).toMatchObject({ status: "REDEEMED", discount: 20 });
      const detail = (await api().get(`/api/v1/admin/promotions/${promoId}`).set(as("admin")).expect(200)).body.data;
      expect(detail.promo).toMatchObject({ usedCount: 1, redeemedCount: 1, discountGiven: 20 });
    });

    it("enforces the per-user limit", async () => {
      const response = await api().post("/api/v1/rides").set(as("customerA")).send({ ...trip(), promoCode: "BRAJ20" }).expect(400);
      expect(response.body.code).toBe("PROMO_USER_LIMIT_REACHED");
      const check = await api().post("/api/v1/promotions/check").set(as("customerA")).send({ code: "BRAJ20" }).expect(400);
      expect(check.body.code).toBe("PROMO_USER_LIMIT_REACHED");
    });

    it("gives the use back when the ride is cancelled", async () => {
      await goOnline();
      const ride = await book("customerB", { ...trip(), promoCode: "BRAJ20" });
      expect((await models.promo.findById(promoId).lean()).usedCount).toBe(2);
      await api().post(`/api/v1/rides/${ride.id}/cancel`).set(as("customerB")).send({ reasonCode: "FOUND_ANOTHER_RIDE" }).expect(200);
      await settle();
      expect((await models.promo.findById(promoId).lean()).usedCount).toBe(1);
      expect((await models.redemption.findOne({ rideId: new Types.ObjectId(ride.id) }).lean()).status).toBe("RELEASED");
    });

    it("enforces the global usage limit", async () => {
      await api().patch(`/api/v1/admin/promotions/${promoId}`).set(as("admin")).send({ usageLimit: 1 }).expect(200);
      const response = await api().post("/api/v1/promotions/validate").set(as("customerB")).send({ ...trip(), code: "BRAJ20" }).expect(400);
      expect(response.body.code).toBe("PROMO_USAGE_LIMIT_REACHED");
      await api().patch(`/api/v1/admin/promotions/${promoId}`).set(as("admin")).send({ usageLimit: 0 }).expect(400);
    });

    it("needs a reason to deactivate, and an inactive promo is refused", async () => {
      await api().patch(`/api/v1/admin/promotions/${promoId}`).set(as("admin")).send({ usageLimit: 5 }).expect(200);
      await api().patch(`/api/v1/admin/promotions/${promoId}/status`).set(as("admin")).send({ status: "INACTIVE" }).expect(400);
      await api().patch(`/api/v1/admin/promotions/${promoId}/status`).set(as("admin")).send({ status: "INACTIVE", reason: "Budget spent" }).expect(200);
      const response = await api().post("/api/v1/promotions/validate").set(as("customerB")).send({ ...trip(), code: "BRAJ20" }).expect(400);
      expect(response.body.code).toBe("PROMO_INACTIVE");
    });
  });

  // ── Cancellations ────────────────────────────────────────────────────

  describe("Cancellations", () => {
    it("lists controlled reasons per actor with no fee under the seeded policy", async () => {
      await goOnline();
      const ride = await book("customerA");
      const preview = (await api().get(`/api/v1/rides/${ride.id}/cancellation`).set(as("customerA")).expect(200)).body.data;
      expect(preview.cancellable).toBe(true);
      expect(preview.fee).toMatchObject({ amount: 0, applies: false });
      expect(preview.reasons.map((reason: { code: string }) => reason.code)).toEqual(
        expect.arrayContaining(["CHANGED_MIND", "DRIVER_TOO_LONG", "OTHER"]),
      );
      expect(preview.reasons.map((reason: { code: string }) => reason.code)).not.toContain("CUSTOMER_UNREACHABLE");

      const bad = await api().post(`/api/v1/rides/${ride.id}/cancel`).set(as("customerA")).send({ reasonCode: "VEHICLE_ISSUE" }).expect(400);
      expect(bad.body.code).toBe("CANCELLATION_REASON_INVALID");
      await api().post(`/api/v1/rides/${ride.id}/cancel`).set(as("customerA")).send({ reasonCode: "OTHER" }).expect(400);
      const cancelled = await api().post(`/api/v1/rides/${ride.id}/cancel`).set(as("customerA")).send({ reasonCode: "OTHER", reason: "Weather" }).expect(200);
      expect(cancelled.body.data.cancellation).toMatchObject({ reasonCode: "OTHER", reason: "Other: Weather", feeStatus: "NOT_APPLICABLE" });

      const again = await api().post(`/api/v1/rides/${ride.id}/cancel`).set(as("customerA")).send({ reasonCode: "CHANGED_MIND" }).expect(409);
      expect(again.body.code).toBe("RIDE_NOT_CANCELLABLE");
      await api().post(`/api/v1/rides/${ride.id}/complete`).set(as("driverA")).expect(409);
    });

    it("charges the configured fee after the driver accepts, records it, and lets admin waive it", async () => {
      await api()
        .patch("/api/v1/admin/cancellations/policy")
        .set(as("admin"))
        .send({
          note: "Pilot fee",
          customerFee: { enabled: true, graceSeconds: 0, fixedFee: 10, percentOfFare: 10, maxFee: 50, applicableStatuses: ["DRIVER_ACCEPTED", "DRIVER_ARRIVED"] },
        })
        .expect(200);

      await goOnline();
      const beforeAccept = await book("customerA");
      const free = (await api().get(`/api/v1/rides/${beforeAccept.id}/cancellation`).set(as("customerA")).expect(200)).body.data;
      expect(free.fee.applies).toBe(false);
      await api().post(`/api/v1/rides/${beforeAccept.id}/cancel`).set(as("customerA")).send({ reasonCode: "CHANGED_MIND" }).expect(200);

      await goOnline();
      const ride = await book("customerA");
      await accept(ride.id);
      const expectedFee = Math.min(50, Math.round(10 + ride.fare.estimatedFare * 0.1));
      const preview = (await api().get(`/api/v1/rides/${ride.id}/cancellation`).set(as("customerA")).expect(200)).body.data;
      expect(preview.fee).toMatchObject({ applies: true, amount: expectedFee });

      const cancelled = (await api().post(`/api/v1/rides/${ride.id}/cancel`).set(as("customerA")).send({ reasonCode: "DRIVER_TOO_LONG" }).expect(200)).body.data;
      expect(cancelled.cancellation).toMatchObject({ cancelledBy: "CUSTOMER", reasonCode: "DRIVER_TOO_LONG", feeAmount: expectedFee, feeStatus: "DUE" });
      const record = await models.cancellation.findOne({ rideId: new Types.ObjectId(ride.id) }).lean();
      expect(record).toMatchObject({ rideStatusAtCancellation: "DRIVER_ACCEPTED", feeAmount: expectedFee, feeStatus: "DUE", policyVersion: 2 });

      const customer = (await api().get(`/api/v1/admin/customers/${userIds.customerA}`).set(as("admin")).expect(200)).body.data;
      expect(customer.stats.outstandingCancellationFees).toBe(expectedFee);

      const waived = await api().post(`/api/v1/admin/cancellations/${record._id}/fee`).set(as("admin")).send({ status: "WAIVED", note: "First time" }).expect(200);
      expect(waived.body.data.feeStatus).toBe("WAIVED");
      expect((await api().get(`/api/v1/rides/${ride.id}`).set(as("customerA")).expect(200)).body.data.cancellation.feeStatus).toBe("WAIVED");
      const twice = await api().post(`/api/v1/admin/cancellations/${record._id}/fee`).set(as("admin")).send({ status: "COLLECTED", note: "Again" }).expect(409);
      expect(twice.body.code).toBe("CANCELLATION_FEE_NOT_DUE");
    });

    it("never charges a driver; drivers pick from driver reasons", async () => {
      await goOnline();
      const ride = await book("customerA");
      await accept(ride.id);
      const preview = (await api().get(`/api/v1/rides/${ride.id}/cancellation`).set(as("driverA")).expect(200)).body.data;
      expect(preview.reasons.map((reason: { code: string }) => reason.code)).toContain("CUSTOMER_UNREACHABLE");
      const cancelled = (await api().post(`/api/v1/rides/${ride.id}/cancel`).set(as("driverA")).send({ reasonCode: "CUSTOMER_UNREACHABLE" }).expect(200)).body.data;
      expect(cancelled.cancellation).toMatchObject({ cancelledBy: "DRIVER", feeAmount: 0, feeStatus: "NOT_APPLICABLE" });
    });

    it("refuses cancellation once the trip has started, and after completion", async () => {
      await goOnline();
      const ride = await book("customerA");
      await accept(ride.id);
      await startTrip(ride.id, "customerA");
      const started = await api().post(`/api/v1/rides/${ride.id}/cancel`).set(as("customerA")).send({ reasonCode: "CHANGED_MIND" }).expect(409);
      expect(started.body.code).toBe("RIDE_NOT_CANCELLABLE");
      await api().post(`/api/v1/admin/rides/${ride.id}/cancel`).set(as("admin")).send({ reason: "Should fail" }).expect(409);
      await api().post(`/api/v1/rides/${ride.id}/complete`).set(as("driverA")).expect(200);
      await api().post(`/api/v1/rides/${ride.id}/cancel`).set(as("customerA")).send({ reasonCode: "CHANGED_MIND" }).expect(409);
      await api().post(`/api/v1/rides/${ride.id}/start`).set(as("driverA")).send({ otp: "1234" }).expect(409);
      await payCash("customerA", ride.id);
    });

    it("records admin cancellations with an admin reason and an audit entry", async () => {
      await goOnline();
      const ride = await book("customerB");
      const detail = (await api().post(`/api/v1/admin/rides/${ride.id}/cancel`).set(as("admin")).send({ reasonCode: "CUSTOMER_REQUEST", reason: "Called support" }).expect(200)).body.data;
      expect(detail.cancellation).toMatchObject({ cancelledBy: "ADMIN", reasonCode: "CUSTOMER_REQUEST", feeAmount: 0 });
      const audit = (await api().get(`/api/v1/admin/audit-logs?targetType=RIDE&targetId=${ride.id}`).set(as("admin")).expect(200)).body.data.items;
      expect(audit[0]).toMatchObject({ action: "ride.cancel", reason: "Called support", adminName: "Ops" });

      // Back to no fees for the rest of the suite.
      await api()
        .patch("/api/v1/admin/cancellations/policy")
        .set(as("admin"))
        .send({ note: "Pilot over", customerFee: { enabled: false, graceSeconds: 0, fixedFee: 0, percentOfFare: 0, maxFee: 0, applicableStatuses: [] } })
        .expect(200);
    });

    it("lets admins manage reasons without renaming codes", async () => {
      await api().post("/api/v1/admin/cancellations/reasons").set(as("admin")).send({ code: "LONG_QUEUE", actor: "CUSTOMER", label: "Queue at the temple" }).expect(201);
      await api().patch("/api/v1/admin/cancellations/reasons/CUSTOMER/LONG_QUEUE").set(as("admin")).send({ isActive: false }).expect(200);
      await api().patch("/api/v1/admin/cancellations/reasons/CUSTOMER/OTHER").set(as("admin")).send({ isActive: false }).expect(400);
      await api().patch("/api/v1/admin/cancellations/reasons/SYSTEM/OTHER").set(as("admin")).send({ label: "x" }).expect(400);
    });
  });

  // ── Customers & drivers (admin actions) ──────────────────────────────

  describe("Admin customer and driver actions", () => {
    it("searches customers and blocks one with immediate effect", async () => {
      const list = (await api().get("/api/v1/admin/customers?search=meera").set(as("admin")).expect(200)).body.data;
      expect(list.items).toHaveLength(1);
      expect(list.items[0]).toMatchObject({ phone: PHONES.customerB, status: "ACTIVE" });

      await api().post(`/api/v1/admin/customers/${userIds.customerB}/block`).set(as("admin")).send({}).expect(400);
      await api().post(`/api/v1/admin/customers/${userIds.customerB}/block`).set(as("admin")).send({ reason: "Abusive to drivers" }).expect(200);
      const locked = await api().get("/api/v1/rides/active").set(as("customerB")).expect(403);
      expect(locked.body.code).toBe("USER_BLOCKED");
      await api().post("/api/v1/auth/login").send({ phone: PHONES.customerB, password: PASSWORD }).expect(403);

      await api().post(`/api/v1/admin/customers/${userIds.customerB}/unblock`).set(as("admin")).send({}).expect(200);
      await login("customerB");
      await api().get("/api/v1/rides/active").set(as("customerB")).expect(200);
    });

    it("pages and searches drivers, and suspends/reinstates with a reason", async () => {
      const page = (await api().get("/api/v1/admin/drivers?status=APPROVED&limit=1").set(as("admin")).expect(200)).body.data;
      expect(page).toMatchObject({ total: 2, limit: 1, hasMore: true });
      const found = (await api().get(`/api/v1/admin/drivers?search=${encodeURIComponent(PHONES.driverB.slice(3))}`).set(as("admin")).expect(200)).body.data;
      expect(found.items.map((item: { driver: { id: string } }) => item.driver.id)).toEqual([driverIds.driverB]);

      await goOnline("driverB");
      await api().patch(`/api/v1/admin/drivers/${driverIds.driverB}/suspend`).set(as("admin")).send({}).expect(400);
      const suspended = await api().patch(`/api/v1/admin/drivers/${driverIds.driverB}/suspend`).set(as("admin")).send({ reason: "Documents expired" }).expect(200);
      expect(suspended.body.data).toMatchObject({ driverStatus: "SUSPENDED", isOnline: false, suspensionReason: "Documents expired" });
      const online = await api().patch("/api/v1/drivers/availability").set(as("driverB")).send({ isOnline: true, ...NEAR_PICKUP }).expect(403);
      expect(online.body.code).toBe("DRIVER_NOT_APPROVED");
      await api().patch(`/api/v1/admin/drivers/${driverIds.pendingDriver}/suspend`).set(as("admin")).send({ reason: "n/a" }).expect(400);

      await api().patch(`/api/v1/admin/drivers/${driverIds.driverB}/reinstate`).set(as("admin")).send({}).expect(200);
      await settle();
      const inbox = (await api().get("/api/v1/notifications").set(as("driverB")).expect(200)).body.data.items;
      expect(inbox.map((item: { type: string }) => item.type)).toEqual(expect.arrayContaining(["DRIVER_SUSPENDED", "DRIVER_REINSTATED"]));
      const audit = (await api().get(`/api/v1/admin/audit-logs?targetType=DRIVER&targetId=${driverIds.driverB}`).set(as("admin")).expect(200)).body.data.items;
      expect(audit.map((entry: { action: string }) => entry.action)).toEqual(["driver.reinstate", "driver.suspend"]);
    });

    it("refuses to suspend a driver in the middle of a ride", async () => {
      await goOnline();
      const ride = await book("customerA");
      await accept(ride.id);
      const refused = await api().patch(`/api/v1/admin/drivers/${driverIds.driverA}/suspend`).set(as("admin")).send({ reason: "Test" }).expect(409);
      expect(refused.body.code).toBe("DRIVER_HAS_ACTIVE_RIDE");
      const blocked = await api().post(`/api/v1/admin/customers/${userIds.customerA}/block`).set(as("admin")).send({ reason: "Test" }).expect(409);
      expect(blocked.body.code).toBe("RIDE_ALREADY_ACTIVE");
      await api().post(`/api/v1/rides/${ride.id}/cancel`).set(as("driverA")).send({ reasonCode: "EMERGENCY" }).expect(200);
    });

    it("lists vehicles with their driver", async () => {
      const vehicles = (await api().get("/api/v1/admin/vehicles?search=7002").set(as("admin")).expect(200)).body.data.items;
      expect(vehicles).toHaveLength(1);
      expect(vehicles[0]).toMatchObject({ registrationNumber: "UP85CC7002", driver: { id: driverIds.driverB } });
    });
  });

  // ── Broadcasts ───────────────────────────────────────────────────────

  describe("Broadcasts", () => {
    it("sends a broadcast to all customers only, once per user, resumably in batches", async () => {
      const audience = (await api().get("/api/v1/admin/broadcasts/audience?audience=ALL_CUSTOMERS").set(as("admin")).expect(200)).body.data;
      expect(audience.recipients).toBe(2);

      const draft = (await api()
        .post("/api/v1/admin/broadcasts")
        .set(as("admin"))
        .send({ title: "Road closed", message: "Parikrama Marg closed 6–10 am", audience: "ALL_CUSTOMERS", deepLink: "HOME" })
        .expect(201)).body.data;
      expect(draft.status).toBe("DRAFT");

      const sending = (await api().post(`/api/v1/admin/broadcasts/${draft.id}/send`).set(as("admin")).expect(200)).body.data;
      expect(sending.status).toBe("SENDING");
      await drainBroadcasts();
      const sent = (await api().get(`/api/v1/admin/broadcasts/${draft.id}`).set(as("admin")).expect(200)).body.data;
      expect(sent).toMatchObject({ status: "SENT", processedCount: 2 });

      const customerInbox = (await api().get("/api/v1/notifications").set(as("customerA")).expect(200)).body.data.items;
      const announcement = customerInbox.find((item: { type: string }) => item.type === "ANNOUNCEMENT");
      expect(announcement).toMatchObject({ title: "Road closed", data: { deepLink: "HOME", broadcastId: draft.id } });
      const driverInbox = (await api().get("/api/v1/notifications").set(as("driverA")).expect(200)).body.data.items;
      expect(driverInbox.some((item: { type: string }) => item.type === "ANNOUNCEMENT")).toBe(false);

      await api().post(`/api/v1/admin/broadcasts/${draft.id}/send`).set(as("admin")).expect(409);
      await api().patch(`/api/v1/admin/broadcasts/${draft.id}`).set(as("admin")).send({ title: "Edited" }).expect(409);
    });

    it("schedules, cancels, and sends due broadcasts from the worker", async () => {
      const past = await api()
        .post("/api/v1/admin/broadcasts")
        .set(as("admin"))
        .send({ title: "Too late", message: "x x x", audience: "ALL_DRIVERS", scheduledAt: new Date(Date.now() - 60_000).toISOString() })
        .expect(400);
      expect(past.body.code).toBe("BROADCAST_INVALID_SCHEDULE");

      const future = new Date(Date.now() + 3_600_000).toISOString();
      const cancelMe = (await api().post("/api/v1/admin/broadcasts").set(as("admin")).send({ title: "Later", message: "Later msg", audience: "ALL_DRIVERS", scheduledAt: future }).expect(201)).body.data;
      expect(cancelMe.status).toBe("SCHEDULED");
      expect((await api().post(`/api/v1/admin/broadcasts/${cancelMe.id}/cancel`).set(as("admin")).expect(200)).body.data.status).toBe("CANCELLED");

      const due = (await api().post("/api/v1/admin/broadcasts").set(as("admin")).send({ title: "Drivers meet", message: "Meeting at depot", audience: "APPROVED_DRIVERS", scheduledAt: future }).expect(201)).body.data;
      await models.broadcast.updateOne({ _id: due.id }, { $set: { scheduledAt: new Date(Date.now() - 1_000) } });
      await runDueBroadcasts();
      await drainBroadcasts();
      expect((await api().get(`/api/v1/admin/broadcasts/${due.id}`).set(as("admin")).expect(200)).body.data).toMatchObject({ status: "SENT", processedCount: 2 });
      const pendingInbox = (await api().get("/api/v1/notifications").set(as("pendingDriver")).expect(200)).body.data.items;
      expect(pendingInbox.some((item: { type: string }) => item.type === "ANNOUNCEMENT")).toBe(false);
    });
  });

  // ── Reports ──────────────────────────────────────────────────────────

  describe("Reports reconcile with the underlying records", () => {
    it("overview totals equal the rides, payments and earnings collections", async () => {
      const overview = (await api().get("/api/v1/admin/reports/overview?preset=TODAY").set(as("admin")).expect(200)).body.data;
      const since = new Date(overview.range.from);
      const until = new Date(overview.range.to);
      const completed = await models.ride.find({ status: "COMPLETED", completedAt: { $gte: since, $lt: until } }).lean();
      const cancelled = await models.ride.countDocuments({ status: "CANCELLED", cancelledAt: { $gte: since, $lt: until } });
      const payments = await models.payment.find({ status: "CAPTURED", paidAt: { $gte: since, $lt: until } }).lean();
      const earnings = await models.earning.find({ rideCompletedAt: { $gte: since, $lt: until } }).lean();
      const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

      expect(overview.rides.completed).toBe(completed.length);
      expect(overview.rides.completed).toBe(2);
      expect(overview.rides.cancelled).toBe(cancelled);
      expect(overview.money.completedRideValue).toBe(sum(completed.map((ride) => ride.fare.finalFare)));
      expect(overview.money.promoDiscounts).toBe(20);
      expect(overview.money.collected).toBe(sum(payments.map((payment) => payment.amountPaise)) / 100);
      expect(overview.money.platformCommission).toBe(sum(earnings.map((earning) => earning.commissionPaise)) / 100);
      expect(overview.money.driverEarnings).toBe(sum(earnings.map((earning) => earning.netEarningPaise)) / 100);
      expect(overview.customers).toMatchObject({ total: 2, new: 2 });
      expect(overview.drivers.approved).toBe(2);
    });

    it("rides report: cohort outcomes add up, with ride-type, zone and day breakdowns", async () => {
      const report = (await api().get("/api/v1/admin/reports/rides?preset=LAST_7_DAYS").set(as("admin")).expect(200)).body.data;
      const requested = await models.ride.countDocuments({});
      expect(report.totals.requested).toBe(requested);
      expect(report.byDay).toHaveLength(7);
      expect(report.byDay.reduce((total: number, day: { requested: number }) => total + day.requested, 0)).toBe(requested);
      expect(report.byRideType.reduce((total: number, row: { requested: number }) => total + row.requested, 0)).toBe(requested);
      expect(report.byZone.map((row: { label: string }) => row.label)).toContain("Vrindavan");
      expect(report.totals.completionRate).toBeGreaterThan(0);
      expect(report.averages.fare).toBeGreaterThan(0);
    });

    it("revenue report: net revenue = commission − platform-funded discounts", async () => {
      const revenue = (await api().get("/api/v1/admin/reports/revenue?preset=TODAY").set(as("admin")).expect(200)).body.data.totals;
      expect(revenue.customerPayable).toBe(revenue.completedRideValue - revenue.promoDiscounts);
      expect(revenue.platformNetRevenue).toBeCloseTo(revenue.platformCommission - 20, 2);
      expect(revenue.collectedCash).toBe(revenue.collected);
      expect(revenue.cancellationFeesWaived).toBeGreaterThan(0);
      expect(revenue.cancellationFeesDue).toBe(0);
    });

    it("cancellations report matches the cancellation records by actor and reason", async () => {
      const report = (await api().get("/api/v1/admin/reports/cancellations?preset=TODAY").set(as("admin")).expect(200)).body.data;
      const byActor = async (actor: string) => models.cancellation.countDocuments({ cancelledBy: actor });
      expect(report.totals.total).toBe(await models.cancellation.countDocuments({}));
      expect(report.totals.byCustomer).toBe(await byActor("CUSTOMER"));
      expect(report.totals.byDriver).toBe(await byActor("DRIVER"));
      expect(report.totals.byAdmin).toBe(await byActor("ADMIN"));
      expect(report.byReason.find((row: { code: string }) => row.code === "DRIVER_TOO_LONG")).toMatchObject({ count: 1 });
      expect(report.fees.waived).toBeGreaterThan(0);
    });

    it("promotions, drivers and customers reports", async () => {
      const promos = (await api().get("/api/v1/admin/reports/promotions?preset=TODAY").set(as("admin")).expect(200)).body.data;
      expect(promos.totals).toMatchObject({ redeemed: 1, released: 1, discountGiven: 20, promoAssistedRides: 1 });
      expect(promos.top[0]).toMatchObject({ code: "BRAJ20", redeemed: 1 });
      const drivers = (await api().get("/api/v1/admin/reports/drivers?preset=TODAY").set(as("admin")).expect(200)).body.data;
      expect(drivers.top[0]).toMatchObject({ driverId: driverIds.driverA });
      expect(drivers.totals).toMatchObject({ approved: 2, pendingKyc: 1 });
      const customers = (await api().get("/api/v1/admin/reports/customers?preset=TODAY").set(as("admin")).expect(200)).body.data;
      expect(customers.totals.active).toBe(2);
      expect(JSON.stringify(customers)).not.toContain(PHONES.customerA);
    });

    it("rejects invalid ranges and serves the dashboard", async () => {
      const bad = await api().get("/api/v1/admin/reports/rides?from=2026-09-10&to=2026-09-01").set(as("admin")).expect(400);
      expect(bad.body.code).toBe("REPORT_RANGE_INVALID");
      const dashboard = (await api().get("/api/v1/admin/dashboard").set(as("admin")).expect(200)).body.data;
      expect(dashboard.trend).toHaveLength(7);
      expect(dashboard.period).toMatchObject({ preset: "TODAY", days: 1, completed: 2 });
      expect(dashboard.totals).toMatchObject({ customers: 2, approvedDrivers: 2 });
      const month = (await api().get("/api/v1/admin/dashboard?preset=LAST_30_DAYS").set(as("admin")).expect(200)).body.data;
      expect(month.period).toMatchObject({ preset: "LAST_30_DAYS", days: 30, completed: 2 });
      expect(month.trend).toHaveLength(30);
      const week = `from=${dashboard.trend[0].date}&to=${dashboard.trend[6].date}`;
      const custom = (await api().get(`/api/v1/admin/dashboard?${week}`).set(as("admin")).expect(200)).body.data;
      expect(custom.period).toMatchObject({ preset: "CUSTOM", days: 7 });
      await api().get("/api/v1/admin/dashboard?from=2026-09-10&to=2026-09-01").set(as("admin")).expect(400);
    });
  });

  // ── Matching rules ───────────────────────────────────────────────────

  describe("Matching", () => {
    // A far-away area and vehicle type nobody else in this suite uses.
    const MUMBAI = { latitude: 19.076, longitude: 72.8777 };
    const near = (metres: number) => ({ latitude: MUMBAI.latitude + metres / 111_000, longitude: MUMBAI.longitude });
    let matching: { findCandidates: (query: object) => Promise<Array<{ driverId: Types.ObjectId; distanceMeters: number }>>; reserve: (driverId: Types.ObjectId, rideId: Types.ObjectId) => Promise<boolean> };
    const ids: Record<string, Types.ObjectId> = {};

    async function seedDriver(label: string, overrides: Record<string, unknown>, at = near(500)) {
      const doc = await models.driver.create({
        userId: new Types.ObjectId(),
        driverCode: `DRM${label.toUpperCase()}`,
        driverStatus: "APPROVED",
        isOnline: true,
        isAvailable: true,
        activeVehicleType: "E_RICKSHAW",
        currentLocation: { type: "Point", coordinates: [at.longitude, at.latitude] },
        locationUpdatedAt: new Date(),
        ...overrides,
      });
      ids[label] = doc._id;
    }

    beforeAll(async () => {
      const { MatchingService } = await import("../src/modules/matching/matching.service");
      matching = app.get(MatchingService, { strict: false });
      await seedDriver("nearest", {}, near(300));
      await seedDriver("second", {}, near(900));
      await seedDriver("offline", { isOnline: false }, near(100));
      await seedDriver("busy", { isAvailable: false, currentRideId: new Types.ObjectId() }, near(120));
      await seedDriver("pending", { driverStatus: "UNDER_REVIEW" }, near(130));
      await seedDriver("suspended", { driverStatus: "SUSPENDED" }, near(140));
      await seedDriver("cab", { activeVehicleType: "CAB" }, near(150));
      await seedDriver("stale", { locationUpdatedAt: new Date(Date.now() - 3_600_000) }, near(160));
      await seedDriver("far", {}, near(60_000));
    });

    const query = (extra: object = {}) => matching.findCandidates({ pickup: MUMBAI, vehicleType: "E_RICKSHAW", ...extra });

    it("finds only eligible drivers, nearest first", async () => {
      const candidates = await query();
      expect(candidates.map((candidate) => candidate.driverId.toString())).toEqual([ids.nearest.toString(), ids.second.toString()]);
      expect(candidates[0].distanceMeters).toBeLessThan(candidates[1].distanceMeters);
    });

    it("excludes offline, busy, unapproved, suspended, wrong-vehicle, stale and out-of-radius drivers", async () => {
      const found = (await query()).map((candidate) => candidate.driverId.toString());
      for (const label of ["offline", "busy", "pending", "suspended", "cab", "stale", "far"]) expect(found).not.toContain(ids[label].toString());
    });

    it("skips drivers who already rejected the ride", async () => {
      const candidates = await query({ excludeDriverIds: [ids.nearest] });
      expect(candidates.map((candidate) => candidate.driverId.toString())).toEqual([ids.second.toString()]);
    });

    it("finds nobody for a vehicle type with no drivers nearby", async () => {
      expect(await matching.findCandidates({ pickup: MUMBAI, vehicleType: "BIKE" })).toEqual([]);
    });

    it("reserves a driver for exactly one ride", async () => {
      const [first, second] = await Promise.all([
        matching.reserve(ids.second, new Types.ObjectId()),
        matching.reserve(ids.second, new Types.ObjectId()),
      ]);
      expect([first, second].filter(Boolean)).toHaveLength(1);
      expect((await query()).map((candidate) => candidate.driverId.toString())).toEqual([ids.nearest.toString()]);
      expect(await matching.reserve(ids.pending, new Types.ObjectId())).toBe(false);
    });
  });
});
