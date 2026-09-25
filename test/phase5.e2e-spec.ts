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
import { PushGateway } from "../src/modules/notifications/push/push.gateway";
import type { PushMessage, PushResult } from "../src/modules/notifications/push/push.gateway";
import { RazorpayGateway, RazorpayGatewayError } from "../src/modules/payments/razorpay/razorpay.gateway";
import { razorpayPaymentSignature } from "../src/modules/payments/razorpay/razorpay-signature";
import type { CreateOrderInput, RazorpayOrder, RazorpayPayment } from "../src/modules/payments/razorpay/razorpay.types";

/**
 * Phase 5 "definition of done": ratings after a verified payment,
 * backend-generated notifications (in-app + FCM) for the ride lifecycle,
 * device-token lifecycle across devices and logout, emergency contacts,
 * SOS with the admin safety workflow, share-ride links, and complaints.
 * Razorpay and FCM are in-memory fakes with the real contracts.
 */

const PASSWORD = "Password@123";
const KEY_SECRET = "e2e_key_secret_value";
const PREM_MANDIR = { address: "Prem Mandir, Vrindavan", latitude: 27.5714, longitude: 77.6716 };
const BANKE_BIHARI = { address: "Banke Bihari Temple, Vrindavan", latitude: 27.5806, longitude: 77.7006 };
const NEAR_PICKUP = { latitude: 27.5725, longitude: 77.677 };

const PHONES = {
  admin: "+919840000000",
  customerA: "+919840000001",
  customerB: "+919840000002",
  driverA: "+919840000011",
  driverC: "+919840000013",
};
type Who = keyof typeof PHONES;

class FakeRazorpay extends RazorpayGateway {
  readonly isConfigured = true;
  readonly keyId = "rzp_test_E2EKEY123";
  readonly orders = new Map<string, RazorpayOrder>();
  readonly payments = new Map<string, RazorpayPayment>();
  private seq = 0;

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}_P5${this.seq.toString().padStart(8, "0")}`;
  }

  async createOrder(input: CreateOrderInput): Promise<RazorpayOrder> {
    const order: RazorpayOrder = {
      id: this.nextId("order"),
      entity: "order",
      amount: input.amountPaise,
      amount_paid: 0,
      amount_due: input.amountPaise,
      currency: input.currency,
      receipt: input.receipt,
      status: "created",
      attempts: 0,
      notes: input.notes,
      created_at: Math.floor(Date.now() / 1000),
    };
    this.orders.set(order.id, order);
    return order;
  }

  async fetchPayment(paymentId: string): Promise<RazorpayPayment> {
    const payment = this.payments.get(paymentId);
    if (!payment) throw new RazorpayGatewayError("Unknown payment", 400, "BAD_REQUEST_ERROR");
    return { ...payment };
  }

  async capturePayment(paymentId: string): Promise<RazorpayPayment> {
    const payment = this.payments.get(paymentId)!;
    payment.status = "captured";
    payment.captured = true;
    return { ...payment };
  }

  async fetchOrderPayments(orderId: string): Promise<RazorpayPayment[]> {
    return [...this.payments.values()].filter((payment) => payment.order_id === orderId);
  }

  pay(orderId: string): RazorpayPayment {
    const order = this.orders.get(orderId)!;
    const payment: RazorpayPayment = {
      id: this.nextId("pay"),
      entity: "payment",
      amount: order.amount,
      currency: order.currency,
      status: "captured",
      order_id: orderId,
      method: "upi",
      captured: true,
      bank: null,
      wallet: null,
      card: null,
      error_code: null,
      error_description: null,
      created_at: Math.floor(Date.now() / 1000),
    };
    this.payments.set(payment.id, payment);
    order.status = "paid";
    return payment;
  }
}

/** FCM with the same contract: tokens starting "dead" are unregistered. */
class FakePush extends PushGateway {
  readonly isConfigured = true;
  readonly sent: Array<{ token: string; message: PushMessage }> = [];

  async send(tokens: string[], message: PushMessage): Promise<PushResult[]> {
    return tokens.map((token) => {
      if (token.startsWith("dead")) return { token, delivered: false, tokenInvalid: true, error: "FCM 404 UNREGISTERED" };
      this.sent.push({ token, message });
      return { token, delivered: true, tokenInvalid: false };
    });
  }

  typesFor(token: string): string[] {
    return this.sent.filter((entry) => entry.token === token).map((entry) => entry.message.data.type);
  }
}

const fcmToken = (label: string) => `${label}:APA91b${randomBytes(24).toString("base64url")}`;

describe("Phase 5 — ratings, notifications, safety, complaints (e2e)", () => {
  const originalCwd = process.cwd();
  let workDir: string;
  let mongo: MongoMemoryServer;
  let app: INestApplication<App>;
  const razorpay = new FakeRazorpay();
  const push = new FakePush();
  const tokens = {} as Record<Who, string>;
  const refreshTokens = {} as Record<Who, string>;
  const userIds = {} as Record<Who, string>;
  let settle: () => Promise<void>;
  let deviceTokenModel: Model<{ token: string; isActive: boolean; userId: unknown; deactivationReason?: string }>;
  let rideModel: Model<{ completedAt?: Date }>;
  let notificationModel: Model<{ userId: unknown; type: string; push: { status: string } }>;

  const api = () => request(app.getHttpServer());
  const as = (who: Who) => ({ Authorization: `Bearer ${tokens[who]}` });

  async function login(who: Who, deviceId = `device-${who}`) {
    const response = await api()
      .post("/api/v1/auth/login")
      .send({ phone: PHONES[who], password: PASSWORD, deviceId })
      .expect(200);
    tokens[who] = response.body.data.accessToken as string;
    refreshTokens[who] = response.body.data.refreshToken as string;
    userIds[who] = response.body.data.user.id as string;
  }

  async function registerToken(who: Who, token: string, deviceId = `device-${who}`, platform = "ANDROID") {
    return (
      await api()
        .post("/api/v1/notifications/device-token")
        .set(as(who))
        .send({ token, platform, deviceId, appVersion: "0.1.0" })
        .expect(200)
    ).body.data;
  }

  async function book(customer: Who) {
    await api().patch("/api/v1/drivers/availability").set(as("driverA")).send({ isOnline: true, ...NEAR_PICKUP }).expect(200);
    const booked = (
      await api()
        .post("/api/v1/rides")
        .set(as(customer))
        .send({ rideType: "AUTO", pickup: PREM_MANDIR, destination: BANKE_BIHARI })
        .expect(201)
    ).body.data as { id: string; status: string; rideCode: string };
    expect(booked.status).toBe("DRIVER_ASSIGNED");
    return booked;
  }

  async function startedRide(customer: Who) {
    const ride = await book(customer);
    await api().post(`/api/v1/rides/${ride.id}/accept`).set(as("driverA")).expect(200);
    await api().post(`/api/v1/rides/${ride.id}/arrived`).set(as("driverA")).expect(200);
    const otp = (await api().get(`/api/v1/rides/${ride.id}`).set(as(customer)).expect(200)).body.data.otp.code;
    await api().post(`/api/v1/rides/${ride.id}/start`).set(as("driverA")).send({ otp }).expect(200);
    return ride;
  }

  async function complete(rideId: string) {
    await api().post(`/api/v1/rides/${rideId}/complete`).set(as("driverA")).expect(200);
  }

  async function pay(customer: Who, rideId: string) {
    const checkout = (await api().post("/api/v1/payments/create").set(as(customer)).send({ rideId }).expect(200)).body
      .data;
    const payment = razorpay.pay(checkout.checkout.orderId);
    await api()
      .post("/api/v1/payments/verify")
      .set(as(customer))
      .send({
        paymentId: checkout.payment.id,
        razorpayOrderId: checkout.checkout.orderId,
        razorpayPaymentId: payment.id,
        razorpaySignature: razorpayPaymentSignature(checkout.checkout.orderId, payment.id, KEY_SECRET),
      })
      .expect(200);
  }

  async function notificationsOf(who: Who, query = "") {
    await settle();
    return (await api().get(`/api/v1/notifications${query}`).set(as(who)).expect(200)).body.data as {
      items: Array<{ id: string; type: string; rideId?: string; isRead: boolean; data: Record<string, string> }>;
      unreadCount: number;
      total: number;
      hasMore: boolean;
    };
  }

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    workDir = await mkdtemp(join(tmpdir(), "tirvona-ride-e2e5-"));
    process.chdir(workDir);
    Object.assign(process.env, {
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      SWAGGER_ENABLED: "false",
      MONGODB_URI: mongo.getUri(),
      MONGODB_DB_NAME: "tirvona_ride_phase5",
      REDIS_URL: "",
      THROTTLE_LIMIT: "5000",
      JWT_ACCESS_SECRET: randomBytes(48).toString("base64url"),
      JWT_REFRESH_SECRET: randomBytes(48).toString("base64url"),
      MATCHING_SWEEP_INTERVAL_MS: "0",
      MATCHING_REACTIVE_DISPATCH: "true",
      RAZORPAY_KEY_ID: razorpay.keyId,
      RAZORPAY_KEY_SECRET: KEY_SECRET,
      RAZORPAY_WEBHOOK_SECRET: "e2e_webhook_secret_value",
      PAYMENT_RECONCILE_INTERVAL_MS: "0",
      PUBLIC_BASE_URL: "https://ride-api.example.test",
      EMERGENCY_CONTACTS_MAX: "3",
      SHARE_RIDE_GRACE_MINUTES: "30",
      SOS_POST_RIDE_GRACE_MINUTES: "30",
    });

    const { AppModule } = await import("../src/app.module");
    const { configureApp } = await import("../src/app.setup");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(RazorpayGateway)
      .useValue(razorpay)
      .overrideProvider(PushGateway)
      .useValue(push)
      .compile();
    app = moduleRef.createNestApplication({ logger: false, rawBody: true });
    configureApp(app);
    await app.init();

    const { DomainEventsService } = await import("../src/infrastructure/events/domain-events.service");
    const { NotificationsService } = await import("../src/modules/notifications/notifications.service");
    const events = app.get(DomainEventsService);
    const notifications = app.get(NotificationsService, { strict: false });
    settle = async () => {
      for (let round = 0; round < 3; round += 1) {
        await events.drain();
        await notifications.drain();
      }
    };

    const { UsersService } = await import("../src/modules/users/users.service");
    const { DriversService } = await import("../src/modules/drivers/drivers.service");
    const { UserRole } = await import("../src/common/types/user-role.enum");
    const { Vehicle, VehicleType } = await import("../src/modules/vehicles/schemas/vehicle.schema");
    const { DriverProfile, DriverStatus } = await import("../src/modules/drivers/schemas/driver-profile.schema");
    const { DeviceToken } = await import("../src/modules/notifications/schemas/device-token.schema");
    const { Ride } = await import("../src/modules/rides/schemas/ride.schema");
    const { Notification } = await import("../src/modules/notifications/schemas/notification.schema");
    deviceTokenModel = app.get(getModelToken(DeviceToken.name), { strict: false });
    rideModel = app.get(getModelToken(Ride.name), { strict: false });
    notificationModel = app.get(getModelToken(Notification.name), { strict: false });
    const driverModel = app.get<Model<unknown>>(getModelToken(DriverProfile.name), { strict: false });
    const vehicleModel = app.get<Model<unknown>>(getModelToken(Vehicle.name), { strict: false });
    const users = app.get(UsersService, { strict: false });
    const drivers = app.get(DriversService, { strict: false });

    await users.create({ phone: PHONES.admin, password: PASSWORD, role: UserRole.ADMIN, firstName: "Ops" });
    for (const key of ["customerA", "customerB"] as const)
      await users.create({ phone: PHONES[key], password: PASSWORD, role: UserRole.CUSTOMER, firstName: key === "customerA" ? "Sachin" : "Meera" });
    const driverUser = await users.create({
      phone: PHONES.driverA,
      password: PASSWORD,
      role: UserRole.DRIVER,
      firstName: "Rahul",
      lastName: "Driver",
    });
    const profile = await drivers.createProfileForUser(driverUser._id.toString());
    await driverModel.updateOne({ _id: profile._id }, { $set: { driverStatus: DriverStatus.APPROVED } });
    await vehicleModel.create({
      driverId: profile._id,
      vehicleType: VehicleType.AUTO,
      registrationNumber: "UP85CC0001",
      make: "Bajaj",
      vehicleModel: "RE",
      color: "Green",
      isActive: true,
    });
    // A driver waiting for KYC review (approval notification).
    const pending = await users.create({ phone: PHONES.driverC, password: PASSWORD, role: UserRole.DRIVER, firstName: "Kishan" });
    const pendingProfile = await drivers.createProfileForUser(pending._id.toString());
    await driverModel.updateOne({ _id: pendingProfile._id }, { $set: { driverStatus: DriverStatus.UNDER_REVIEW } });

    for (const key of Object.keys(PHONES) as Who[]) await login(key);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
    process.chdir(originalCwd);
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  // ── Device tokens ─────────────────────────────────────────────────────

  describe("Device tokens", () => {
    const phoneToken = fcmToken("phone");
    const tabletToken = fcmToken("tablet");
    const driverToken = fcmToken("driver");

    it("registers tokens per device and supports several devices per user", async () => {
      const phone = await registerToken("customerA", phoneToken);
      expect(phone).toMatchObject({ platform: "ANDROID", isActive: true, deviceId: "device-customerA" });
      await registerToken("customerA", tabletToken, "tablet-customerA", "IOS");
      await registerToken("driverA", driverToken);
      expect(await deviceTokenModel.countDocuments({ isActive: true })).toBe(3);
    });

    it("re-registering the same token is idempotent", async () => {
      const again = await registerToken("customerA", phoneToken);
      expect(await deviceTokenModel.countDocuments({ token: phoneToken })).toBe(1);
      expect(again.isActive).toBe(true);
    });

    it("rejects malformed tokens and unknown platforms", async () => {
      await api()
        .post("/api/v1/notifications/device-token")
        .set(as("customerA"))
        .send({ token: "bad token<script>", platform: "ANDROID", deviceId: "x" })
        .expect(400);
      await api()
        .post("/api/v1/notifications/device-token")
        .set(as("customerA"))
        .send({ token: fcmToken("x"), platform: "WEB", deviceId: "x" })
        .expect(400);
      // The user id always comes from the JWT; a body userId is rejected outright.
      await api()
        .post("/api/v1/notifications/device-token")
        .set(as("customerA"))
        .send({ token: fcmToken("x"), platform: "ANDROID", deviceId: "x", userId: userIds.customerB })
        .expect(400);
      await api().post("/api/v1/notifications/device-token").send({ token: fcmToken("x"), platform: "ANDROID", deviceId: "x" }).expect(401);
    });

    it("a token refresh on the same device retires the old token", async () => {
      const oldToken = fcmToken("refresh-old");
      const newToken = fcmToken("refresh-new");
      await registerToken("customerB", oldToken);
      await registerToken("customerB", newToken);
      expect((await deviceTokenModel.findOne({ token: oldToken }).lean())?.isActive).toBe(false);
      expect((await deviceTokenModel.findOne({ token: newToken }).lean())?.isActive).toBe(true);
    });

    it("logout deactivates the device's tokens; logging in again reactivates", async () => {
      const token = (await deviceTokenModel.findOne({ userId: { $exists: true }, token: /^refresh-new/ }).lean())!.token;
      await api().post("/api/v1/auth/logout").send({ refreshToken: refreshTokens.customerB }).expect(200);
      await settle();
      const loggedOut = await deviceTokenModel.findOne({ token }).lean();
      expect(loggedOut).toMatchObject({ isActive: false, deactivationReason: "LOGOUT" });

      await login("customerB");
      await registerToken("customerB", token);
      expect((await deviceTokenModel.findOne({ token }).lean())?.isActive).toBe(true);
    });

    it("the app's explicit unregister only touches the caller's own token", async () => {
      const token = fcmToken("explicit");
      await registerToken("customerB", token, "device-explicit");
      const foreign = (
        await api().post("/api/v1/notifications/device-token/deactivate").set(as("customerA")).send({ token }).expect(200)
      ).body.data;
      expect(foreign.deactivated).toBe(false);
      const own = (
        await api().post("/api/v1/notifications/device-token/deactivate").set(as("customerB")).send({ token }).expect(200)
      ).body.data;
      expect(own.deactivated).toBe(true);
    });

    it("a token signed in on another account moves to that account", async () => {
      const shared = fcmToken("shared");
      await registerToken("customerB", shared, "shared-phone");
      await registerToken("customerA", shared, "shared-phone");
      const row = await deviceTokenModel.findOne({ token: shared }).lean();
      expect(String(row?.userId)).toBe(userIds.customerA);
      // Clean up so later push assertions only count customerA's two devices.
      await api().post("/api/v1/notifications/device-token/deactivate").set(as("customerA")).send({ token: shared }).expect(200);
    });
  });

  // ── Ride lifecycle notifications, rating ─────────────────────────────

  describe("Ride 1 — lifecycle notifications, payment, rating", () => {
    let ride: { id: string; rideCode: string };

    it("pushes each lifecycle event to the right people on every device", async () => {
      push.sent.length = 0;
      ride = await startedRide("customerA");
      await settle();
      // Both of customerA's devices get the same pushes.
      const phoneTypes = push.sent.filter((entry) => entry.message.data.rideId === ride.id && entry.token.startsWith("phone")).map((e) => e.message.data.type);
      const tabletTypes = push.sent.filter((entry) => entry.message.data.rideId === ride.id && entry.token.startsWith("tablet")).map((e) => e.message.data.type);
      expect(phoneTypes).toEqual(["RIDE_DRIVER_ASSIGNED", "RIDE_DRIVER_ACCEPTED", "RIDE_DRIVER_ARRIVED", "RIDE_STARTED"]);
      expect(tabletTypes).toEqual(phoneTypes);
      const driverTypes = push.sent
        .filter((entry) => entry.message.data.rideId === ride.id && entry.token.startsWith("driver"))
        .map((e) => e.message.data.type);
      expect(driverTypes).toEqual(["RIDE_REQUEST", "RIDE_STARTED"]);
      // Ride offers and arrivals are high priority; ride pushes collapse per ride.
      const offer = push.sent.find((entry) => entry.message.data.type === "RIDE_REQUEST")!;
      expect(offer.message.highPriority).toBe(true);
      const arrived = push.sent.find((entry) => entry.message.data.type === "RIDE_DRIVER_ARRIVED")!;
      expect(arrived.message.collapseKey).toBe(`ride-${ride.id}`);
      expect(arrived.message.body).toContain("Rahul (UP85CC0001)");
    });

    it("stores in-app notifications, newest first, with an unread count", async () => {
      const page = await notificationsOf("customerA", "?limit=2");
      expect(page.items.map((item) => item.type)).toEqual(["RIDE_STARTED", "RIDE_DRIVER_ARRIVED"]);
      expect(page.total).toBe(4);
      expect(page.hasMore).toBe(true);
      expect(page.unreadCount).toBe(4);
      expect(page.items[0]).toMatchObject({ rideId: ride.id, isRead: false, data: { rideId: ride.id } });
      const pushStatuses = await notificationModel.find({ type: "RIDE_STARTED" }).lean();
      expect(pushStatuses.every((row) => row.push.status === "SENT")).toBe(true);
    });

    it("marks read (own notifications only) and keeps the badge in sync", async () => {
      const page = await notificationsOf("customerA");
      const first = page.items[0];
      await api().patch(`/api/v1/notifications/${first.id}/read`).set(as("customerB")).expect(404);
      const read = (await api().patch(`/api/v1/notifications/${first.id}/read`).set(as("customerA")).expect(200)).body.data;
      expect(read.isRead).toBe(true);
      // Idempotent.
      await api().patch(`/api/v1/notifications/${first.id}/read`).set(as("customerA")).expect(200);
      const count = (await api().get("/api/v1/notifications/unread-count").set(as("customerA")).expect(200)).body.data;
      expect(count.unreadCount).toBe(3);
      const unread = await notificationsOf("customerA", "?unreadOnly=true");
      expect(unread.items).toHaveLength(3);
      await api().patch("/api/v1/notifications/nope/read").set(as("customerA")).expect(400);
    });

    it("cannot be rated before the ride is completed and paid", async () => {
      const early = await api().post(`/api/v1/rides/${ride.id}/rating`).set(as("customerA")).send({ rating: 5 }).expect(409);
      expect(early.body.code).toBe("RATING_NOT_ALLOWED");
      await complete(ride.id);
      await settle();
      expect(push.typesFor([...push.sent].reverse().find((e) => e.token.startsWith("driver"))!.token)).toContain("RIDE_COMPLETED");
      const status = (await api().get(`/api/v1/rides/${ride.id}/rating`).set(as("customerA")).expect(200)).body.data;
      expect(status).toMatchObject({ canRate: false, reason: "PAYMENT_NOT_VERIFIED", rating: null });
      expect(status.driver).toMatchObject({ name: "Rahul Driver", vehicle: { registrationNumber: "UP85CC0001" } });
      const unpaid = await api().post(`/api/v1/rides/${ride.id}/rating`).set(as("customerA")).send({ rating: 5 }).expect(409);
      expect(unpaid.body.message).toContain("payment");
    });

    it("payment success notifies the customer and the driver", async () => {
      await pay("customerA", ride.id);
      const customer = await notificationsOf("customerA");
      expect(customer.items[0]).toMatchObject({ type: "PAYMENT_SUCCESS", rideId: ride.id });
      const driver = await notificationsOf("driverA");
      expect(driver.items.map((item) => item.type)).toContain("PAYMENT_RECEIVED");
    });

    it("validates the rating value", async () => {
      for (const rating of [0, 6, 2.5, "5", null]) {
        await api().post(`/api/v1/rides/${ride.id}/rating`).set(as("customerA")).send({ rating }).expect(400);
      }
      // The driver is derived from the ride, never accepted from the app.
      await api()
        .post(`/api/v1/rides/${ride.id}/rating`)
        .set(as("customerA"))
        .send({ rating: 5, driverId: "64b7f0c2a1b2c3d4e5f60718" })
        .expect(400);
    });

    it("only the ride's customer can rate it", async () => {
      await api().get(`/api/v1/rides/${ride.id}/rating`).set(as("customerB")).expect(404);
      await api().post(`/api/v1/rides/${ride.id}/rating`).set(as("customerB")).send({ rating: 1 }).expect(404);
      await api().post(`/api/v1/rides/${ride.id}/rating`).set(as("driverA")).send({ rating: 1 }).expect(403);
    });

    it("stores the rating once and updates the driver's average", async () => {
      const [first, second] = await Promise.all([
        api().post(`/api/v1/rides/${ride.id}/rating`).set(as("customerA")).send({ rating: 5, comment: "  Very polite driver  " }),
        api().post(`/api/v1/rides/${ride.id}/rating`).set(as("customerA")).send({ rating: 1 }),
      ]);
      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([201, 409]);
      const status = (await api().get(`/api/v1/rides/${ride.id}/rating`).set(as("customerA")).expect(200)).body.data;
      expect(status.canRate).toBe(false);
      expect(status.rating.rating).toBe(first.status === 201 ? 5 : 1);
      if (first.status === 201) expect(status.rating.comment).toBe("Very polite driver");
      const duplicate = await api().post(`/api/v1/rides/${ride.id}/rating`).set(as("customerA")).send({ rating: 3 }).expect(409);
      expect(duplicate.body.code).toBe("RATING_ALREADY_EXISTS");

      const me = (await api().get("/api/v1/drivers/me").set(as("driverA")).expect(200)).body.data;
      expect(me.ratingCount).toBe(1);
      expect(me.ratingAverage).toBe(status.rating.rating);
    });

    it("a second rated ride moves the average (4.5 from 5 and 4)", async () => {
      await rideModel.db.collection("ratings").deleteMany({});
      await app.get((await import("../src/modules/ratings/ratings.service")).RatingsService, { strict: false })
        .rebuildDriverAggregate((await rideModel.findById(ride.id).lean() as unknown as { driverId: never }).driverId);
      await api().post(`/api/v1/rides/${ride.id}/rating`).set(as("customerA")).send({ rating: 5 }).expect(201);

      const second = await startedRide("customerB");
      await complete(second.id);
      await pay("customerB", second.id);
      await api().post(`/api/v1/rides/${second.id}/rating`).set(as("customerB")).send({ rating: 4 }).expect(201);

      const summary = (await api().get("/api/v1/drivers/me/ratings").set(as("driverA")).expect(200)).body.data;
      expect(summary).toMatchObject({ ratingAverage: 4.5, ratingCount: 2, distribution: { "5": 1, "4": 1, "1": 0 } });
      const view = (await api().get(`/api/v1/rides/${second.id}`).set(as("customerB")).expect(200)).body.data;
      expect(view.driver).toMatchObject({ ratingAverage: 4.5, ratingCount: 2 });
      await api().get("/api/v1/drivers/me/ratings").set(as("customerA")).expect(403);
    });

    it("read-all clears the badge", async () => {
      const result = (await api().patch("/api/v1/notifications/read-all").set(as("customerA")).expect(200)).body.data;
      expect(result.updated).toBeGreaterThan(0);
      expect((await notificationsOf("customerA")).unreadCount).toBe(0);
    });
  });

  // ── Cancellation, dead tokens, driver review ─────────────────────────

  describe("Other notification sources", () => {
    it("a customer cancellation notifies the driver, not the customer", async () => {
      const ride = await book("customerB");
      await api().post(`/api/v1/rides/${ride.id}/accept`).set(as("driverA")).expect(200);
      await api().post(`/api/v1/rides/${ride.id}/cancel`).set(as("customerB")).send({ reason: "Plans changed" }).expect(200);
      const driver = await notificationsOf("driverA");
      expect(driver.items[0]).toMatchObject({ type: "RIDE_CANCELLED", rideId: ride.id });
      const customer = await notificationsOf("customerB");
      expect(customer.items.find((item) => item.rideId === ride.id && item.type === "RIDE_CANCELLED")).toBeUndefined();
    });

    it("FCM 'unregistered' deactivates the dead token; the in-app record stays", async () => {
      await registerToken("customerB", `dead${fcmToken("x")}`, "dead-device");
      const ride = await book("customerB");
      await settle();
      const dead = await deviceTokenModel.findOne({ token: /^dead/ }).lean();
      expect(dead).toMatchObject({ isActive: false, deactivationReason: "UNREGISTERED" });
      expect((await notificationsOf("customerB")).items[0]).toMatchObject({ type: "RIDE_DRIVER_ASSIGNED", rideId: ride.id });
      await api().post(`/api/v1/rides/${ride.id}/cancel`).set(as("customerB")).send({ reason: "Test" }).expect(200);
    });

    it("driver approval notifies the driver", async () => {
      const drivers = (await api().get("/api/v1/admin/drivers?status=UNDER_REVIEW").set(as("admin")).expect(200)).body.data;
      const pending = drivers.find((item: { user: { phone: string } }) => item.user.phone === PHONES.driverC);
      await api().patch(`/api/v1/admin/drivers/${pending.driver.id}/approve`).set(as("admin")).expect(200);
      const inbox = await notificationsOf("driverC");
      expect(inbox.items[0]).toMatchObject({ type: "DRIVER_APPROVED" });
    });
  });

  // ── Emergency contacts ───────────────────────────────────────────────

  describe("Emergency contacts", () => {
    const base = "/api/v1/users/me/emergency-contacts";
    let papa: { id: string };
    let brother: { id: string };

    it("adds contacts; the first is primary; numbers are normalised", async () => {
      papa = (await api().post(base).set(as("customerA")).send({ name: "Papa", phone: "98765 43210", relationship: "Father" }).expect(201)).body.data;
      expect(papa).toMatchObject({ name: "Papa", phone: "+919876543210", isPrimary: true });
      brother = (await api().post(base).set(as("customerA")).send({ name: "Brother", phone: "+919812300000" }).expect(201)).body.data;
      expect(brother).toMatchObject({ isPrimary: false });
    });

    it("validates name, phone, duplicates and the user's own number", async () => {
      await api().post(base).set(as("customerA")).send({ name: "", phone: "+919812300001" }).expect(400);
      await api().post(base).set(as("customerA")).send({ name: "X", phone: "12" }).expect(400);
      const duplicate = await api().post(base).set(as("customerA")).send({ name: "Again", phone: "9876543210" }).expect(409);
      expect(duplicate.body.code).toBe("EMERGENCY_CONTACT_DUPLICATE");
      const self = await api().post(base).set(as("customerA")).send({ name: "Me", phone: PHONES.customerA }).expect(400);
      expect(self.body.code).toBe("EMERGENCY_CONTACT_SELF");
    });

    it("set primary moves the flag; there is only ever one", async () => {
      const updated = (await api().patch(`${base}/${brother.id}`).set(as("customerA")).send({ isPrimary: true, relationship: "Brother" }).expect(200)).body.data;
      expect(updated).toMatchObject({ isPrimary: true, relationship: "Brother" });
      const list = (await api().get(base).set(as("customerA")).expect(200)).body.data;
      expect(list.map((contact: { name: string; isPrimary: boolean }) => `${contact.name}:${contact.isPrimary}`)).toEqual([
        "Brother:true",
        "Papa:false",
      ]);
      await api().patch(`${base}/${brother.id}`).set(as("customerA")).send({ isPrimary: false }).expect(400);
    });

    it("enforces the per-user limit", async () => {
      await api().post(base).set(as("customerA")).send({ name: "Mummy", phone: "+919812300002", relationship: "Mother" }).expect(201);
      const limit = await api().post(base).set(as("customerA")).send({ name: "Fourth", phone: "+919812300003" }).expect(409);
      expect(limit.body.code).toBe("EMERGENCY_CONTACT_LIMIT");
    });

    it("users only ever see and change their own contacts", async () => {
      expect((await api().get(base).set(as("customerB")).expect(200)).body.data).toEqual([]);
      await api().patch(`${base}/${papa.id}`).set(as("customerB")).send({ name: "Hacked" }).expect(404);
      await api().delete(`${base}/${papa.id}`).set(as("customerB")).expect(404);
      await api().get(base).set(as("admin")).expect(403);
    });

    it("deleting the primary promotes the oldest remaining contact", async () => {
      await api().delete(`${base}/${brother.id}`).set(as("customerA")).expect(200);
      const list = (await api().get(base).set(as("customerA")).expect(200)).body.data;
      expect(list[0]).toMatchObject({ name: "Papa", isPrimary: true });
      expect(list).toHaveLength(2);
    });
  });

  // ── SOS ──────────────────────────────────────────────────────────────

  describe("SOS", () => {
    let ride: { id: string; rideCode: string };
    let sosId: string;

    it("is not available before a driver is involved", async () => {
      await api().patch("/api/v1/drivers/availability").set(as("driverA")).send({ isOnline: false }).expect(200);
      const searching = (
        await api().post("/api/v1/rides").set(as("customerB")).send({ rideType: "AUTO", pickup: PREM_MANDIR, destination: BANKE_BIHARI }).expect(201)
      ).body.data;
      expect(searching.status).toBe("SEARCHING");
      const refused = await api().post(`/api/v1/rides/${searching.id}/sos`).set(as("customerB")).send({}).expect(409);
      expect(refused.body.code).toBe("SOS_NOT_ALLOWED");
      await api().post(`/api/v1/rides/${searching.id}/cancel`).set(as("customerB")).send({ reason: "Test" }).expect(200);
    });

    it("the customer raises SOS during the ride; location and contacts are captured", async () => {
      ride = await startedRide("customerA");
      const result = (
        await api()
          .post(`/api/v1/rides/${ride.id}/sos`)
          .set(as("customerA"))
          .send({ latitude: 27.575, longitude: 77.685, accuracyMeters: 12, address: "Parikrama Marg", message: "Driver is rude" })
          .expect(201)
      ).body.data;
      expect(result.created).toBe(true);
      expect(result.sos).toMatchObject({
        rideId: ride.id,
        status: "TRIGGERED",
        handled: false,
        location: { latitude: 27.575, longitude: 77.685, source: "DEVICE" },
      });
      expect(result.sos.sosCode).toMatch(/^SOS-[A-Z0-9]{6}$/);
      sosId = result.sos.id;
    });

    it("pressing again updates the open incident instead of opening another", async () => {
      const again = (
        await api().post(`/api/v1/rides/${ride.id}/sos`).set(as("customerA")).send({ latitude: 27.576, longitude: 77.686 }).expect(201)
      ).body.data;
      expect(again).toMatchObject({ created: false, sos: { id: sosId, location: { latitude: 27.576 } } });
    });

    it("alerts every admin and confirms to the customer, but not to the driver", async () => {
      const admin = await notificationsOf("admin");
      expect(admin.items[0]).toMatchObject({ type: "SOS_CREATED", data: { sosId } });
      const customer = await notificationsOf("customerA");
      expect(customer.items[0]).toMatchObject({ type: "SOS_CREATED" });
      const driver = await notificationsOf("driverA");
      expect(driver.items.some((item) => item.type.startsWith("SOS"))).toBe(false);
      const summary = (await api().get("/api/v1/admin/sos/summary").set(as("admin")).expect(200)).body.data;
      expect(summary).toMatchObject({ open: 1, unacknowledged: 1 });
      const dashboard = (await api().get("/api/v1/admin/dashboard").set(as("admin")).expect(200)).body.data;
      expect(dashboard.safety.open).toBe(1);
    });

    it("only ride participants can raise or read SOS for a ride", async () => {
      await api().post(`/api/v1/rides/${ride.id}/sos`).set(as("customerB")).send({}).expect(404);
      await api().get(`/api/v1/rides/${ride.id}/sos`).set(as("customerB")).expect(404);
      await api().post(`/api/v1/rides/${ride.id}/sos`).set(as("customerA")).send({ latitude: 27.5 }).expect(400);
      await api().post(`/api/v1/rides/${ride.id}/sos`).set(as("customerA")).send({ latitude: 95, longitude: 77 }).expect(400);
      await api().get("/api/v1/admin/sos").set(as("customerA")).expect(403);
    });

    it("the driver can raise their own alert (a separate incident); without GPS the server falls back", async () => {
      const driverSos = (await api().post(`/api/v1/rides/${ride.id}/sos`).set(as("driverA")).send({}).expect(201)).body.data;
      expect(driverSos.created).toBe(true);
      expect(driverSos.sos.id).not.toBe(sosId);
      expect(["DRIVER_LAST_KNOWN", "RIDE_PICKUP"]).toContain(driverSos.sos.location.source);
    });

    it("admin sees the incident with full ride context", async () => {
      const list = (await api().get("/api/v1/admin/sos?open=true").set(as("admin")).expect(200)).body.data;
      expect(list.total).toBe(2);
      const detail = (await api().get(`/api/v1/admin/sos/${sosId}`).set(as("admin")).expect(200)).body.data;
      expect(detail).toMatchObject({
        status: "TRIGGERED",
        raisedByRole: "CUSTOMER",
        rideCode: ride.rideCode,
        customer: { phone: PHONES.customerA },
        driver: { phone: PHONES.driverA },
        vehiclePlate: "UP85CC0001",
        message: "Driver is rude",
        contactsNotification: "NOT_SENT",
        ride: { pickup: { address: PREM_MANDIR.address }, destination: { address: BANKE_BIHARI.address } },
      });
      expect(detail.emergencyContacts.map((contact: { name: string }) => contact.name)).toEqual(["Papa", "Mummy"]);
      expect(detail.locationUpdates).toHaveLength(1);
    });

    it("admin acknowledges → in progress → resolves, with timestamps and a timeline", async () => {
      const acked = (await api().patch(`/api/v1/admin/sos/${sosId}`).set(as("admin")).send({ status: "ACKNOWLEDGED" }).expect(200)).body.data;
      expect(acked.status).toBe("ACKNOWLEDGED");
      expect(acked.acknowledgedAt).toBeDefined();
      await api().patch(`/api/v1/admin/sos/${sosId}`).set(as("admin")).send({ status: "IN_PROGRESS", note: "Called the rider" }).expect(200);
      const noNote = await api().patch(`/api/v1/admin/sos/${sosId}`).set(as("admin")).send({ status: "RESOLVED" }).expect(400);
      expect(noNote.body.code).toBe("VALIDATION_FAILED");
      const resolved = (
        await api().patch(`/api/v1/admin/sos/${sosId}`).set(as("admin")).send({ status: "RESOLVED", note: "Rider safe, driver warned" }).expect(200)
      ).body.data;
      expect(resolved).toMatchObject({ status: "RESOLVED", resolutionNote: "Rider safe, driver warned", handledBy: { name: "Ops" } });
      expect(resolved.timeline.map((entry: { status: string }) => entry.status)).toEqual([
        "TRIGGERED",
        "ACKNOWLEDGED",
        "IN_PROGRESS",
        "RESOLVED",
      ]);
      expect(new Date(resolved.resolvedAt) >= new Date(resolved.inProgressAt)).toBe(true);
      const backwards = await api().patch(`/api/v1/admin/sos/${sosId}`).set(as("admin")).send({ status: "IN_PROGRESS" }).expect(409);
      expect(backwards.body.code).toBe("SOS_INVALID_TRANSITION");
    });

    it("the customer sees the outcome; history is retained", async () => {
      const mine = (await api().get(`/api/v1/rides/${ride.id}/sos`).set(as("customerA")).expect(200)).body.data;
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({ id: sosId, status: "RESOLVED", handled: true });
      const updates = (await notificationsOf("customerA")).items.filter((item) => item.type === "SOS_UPDATED");
      expect(updates).toHaveLength(3);
      const history = (await api().get("/api/v1/admin/sos?status=RESOLVED").set(as("admin")).expect(200)).body.data;
      expect(history.items[0].id).toBe(sosId);
      // A new press after resolution opens a new incident.
      const fresh = (await api().post(`/api/v1/rides/${ride.id}/sos`).set(as("customerA")).send({}).expect(201)).body.data;
      expect(fresh.created).toBe(true);
    });
  });

  // ── Share ride ───────────────────────────────────────────────────────

  describe("Share ride", () => {
    let rideId: string;
    let link: { url: string; token: string; expiresAt: string; shareText: string };

    it("generates a server-side token for an active ride only, for its customer only", async () => {
      rideId = (await rideModel.findOne({ isActive: true }).lean() as unknown as { _id: { toString(): string } })._id.toString();
      await api().post(`/api/v1/rides/${rideId}/share`).set(as("customerB")).expect(404);
      await api().post(`/api/v1/rides/${rideId}/share`).set(as("driverA")).expect(403);
      link = (await api().post(`/api/v1/rides/${rideId}/share`).set(as("customerA")).expect(201)).body.data;
      expect(link.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
      expect(link.url).toBe(`https://ride-api.example.test/api/v1/shared-rides/view/${link.token}`);
      expect(link.shareText).toContain("Sachin is sharing");
      expect(link.url).not.toContain(rideId);
      expect((await api().get(`/api/v1/rides/${rideId}/share`).set(as("customerA")).expect(200)).body.data.active).toBe(1);
    });

    it("the public status needs no login and exposes nothing private", async () => {
      const response = await api().get(`/api/v1/shared-rides/${link.token}`).expect(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      const view = response.body.data;
      expect(view).toMatchObject({
        status: "RIDE_IN_PROGRESS",
        statusLabel: "Ride in progress",
        isLive: true,
        driver: { firstName: "Rahul" },
        vehicle: { registrationNumber: "UP85CC0001" },
        pickup: { address: PREM_MANDIR.address },
      });
      const raw = JSON.stringify(response.body);
      for (const secret of [PHONES.customerA, PHONES.driverA, rideId, "Sachin", "Driver\"", "paymentStatus", "otp", "customer"])
        expect(raw).not.toContain(secret);
      const page = await api().get(`/api/v1/shared-rides/view/${link.token}`).expect(200);
      expect(page.headers["content-type"]).toContain("text/html");
      expect(page.text).toContain("Ride in progress");
      expect(page.text).not.toContain(PHONES.customerA);
    });

    it("unknown tokens are not found; the link cannot change the ride", async () => {
      const unknown = await api().get(`/api/v1/shared-rides/${randomBytes(24).toString("base64url")}`).expect(404);
      expect(unknown.body.code).toBe("SHARE_LINK_NOT_FOUND");
      await api().get("/api/v1/shared-rides/short").expect(404);
      expect((await api().get(`/api/v1/shared-rides/view/${randomBytes(24).toString("base64url")}`).expect(404)).text).toContain("not found");
      await api().post(`/api/v1/shared-rides/${link.token}`).expect(404);
      await api().patch(`/api/v1/shared-rides/${link.token}`).expect(404);
    });

    it("revoking stops every link; sharing again makes a new one", async () => {
      expect((await api().delete(`/api/v1/rides/${rideId}/share`).set(as("customerA")).expect(200)).body.data.revoked).toBe(1);
      await api().get(`/api/v1/shared-rides/${link.token}`).expect(404);
      link = (await api().post(`/api/v1/rides/${rideId}/share`).set(as("customerA")).expect(201)).body.data;
      await api().get(`/api/v1/shared-rides/${link.token}`).expect(200);
    });

    it("keeps working briefly after the ride ends, then expires", async () => {
      await complete(rideId);
      await settle();
      const ended = (await api().get(`/api/v1/shared-rides/${link.token}`).expect(200)).body.data;
      expect(ended).toMatchObject({ status: "COMPLETED", isLive: false, driverLocation: null });
      const completed = await api().post(`/api/v1/rides/${rideId}/share`).set(as("customerA")).expect(409);
      expect(completed.body.code).toBe("SHARE_NOT_ALLOWED");

      // Past the grace period.
      await rideModel.updateOne({ _id: rideId }, { $set: { completedAt: new Date(Date.now() - 31 * 60_000) } });
      const expired = await api().get(`/api/v1/shared-rides/${link.token}`).expect(410);
      expect(expired.body.code).toBe("SHARE_LINK_EXPIRED");
      expect((await api().get(`/api/v1/shared-rides/view/${link.token}`).expect(410)).text).toContain("expired");
    });
  });

  // ── Complaints ───────────────────────────────────────────────────────

  describe("Complaints", () => {
    let rideId: string;
    let complaintId: string;

    it("a customer reports an issue about their ride", async () => {
      rideId = (await rideModel.findOne({ status: "COMPLETED", customerId: userIds.customerA }).sort({ completedAt: -1 }).lean() as unknown as { _id: { toString(): string } })._id.toString();
      const complaint = (
        await api()
          .post("/api/v1/complaints")
          .set(as("customerA"))
          .send({ rideId, category: "DRIVER_BEHAVIOUR", subject: "Rude behaviour", description: "The driver shouted at me during the ride." })
          .expect(201)
      ).body.data;
      expect(complaint).toMatchObject({ status: "OPEN", rideId, category: "DRIVER_BEHAVIOUR" });
      expect(complaint.ticketCode).toMatch(/^TKT-/);
      expect(complaint).not.toHaveProperty("priority");
      complaintId = complaint.id;
      expect((await notificationsOf("customerA")).items[0].type).toBe("COMPLAINT_CREATED");
      expect((await notificationsOf("admin")).items[0].type).toBe("COMPLAINT_CREATED");
    });

    it("validates category, ride ownership and duplicates", async () => {
      const duplicate = await api()
        .post("/api/v1/complaints")
        .set(as("customerA"))
        .send({ rideId, category: "DRIVER_BEHAVIOUR", subject: "Again", description: "Same complaint once more please." })
        .expect(409);
      expect(duplicate.body).toMatchObject({ code: "COMPLAINT_ALREADY_OPEN", data: { id: complaintId } });
      const wrongRole = await api()
        .post("/api/v1/complaints")
        .set(as("driverA"))
        .send({ rideId, category: "DRIVER_BEHAVIOUR", subject: "Me?", description: "Drivers cannot report drivers." })
        .expect(400);
      expect(wrongRole.body.code).toBe("COMPLAINT_NOT_ALLOWED");
      await api()
        .post("/api/v1/complaints")
        .set(as("customerA"))
        .send({ category: "FARE", subject: "Fare", description: "Which ride? It needs one attached." })
        .expect(400);
      await api()
        .post("/api/v1/complaints")
        .set(as("customerB"))
        .send({ rideId, category: "FARE", subject: "Not mine", description: "This is someone else's ride." })
        .expect(404);
      await api()
        .post("/api/v1/complaints")
        .set(as("customerB"))
        .send({ category: "TECHNICAL", subject: "App crash", description: "The app closes when I open payments." })
        .expect(201);
      await api().get(`/api/v1/complaints/${complaintId}`).set(as("customerB")).expect(404);
    });

    it("the driver can report the customer on a ride they drove", async () => {
      await api()
        .post("/api/v1/complaints")
        .set(as("driverA"))
        .send({ rideId, category: "CUSTOMER_BEHAVIOUR", subject: "Late customer", description: "Customer kept me waiting 20 minutes." })
        .expect(201);
    });

    it("admin triages, reviews and resolves; the user sees the outcome", async () => {
      await api().get("/api/v1/admin/complaints").set(as("customerA")).expect(403);
      const open = (await api().get("/api/v1/admin/complaints?status=OPEN").set(as("admin")).expect(200)).body.data;
      expect(open.total).toBe(3);
      const detail = (await api().get(`/api/v1/admin/complaints/${complaintId}`).set(as("admin")).expect(200)).body.data;
      expect(detail).toMatchObject({
        priority: "HIGH",
        user: { phone: PHONES.customerA },
        driver: { phone: PHONES.driverA },
        ride: { id: rideId, status: "COMPLETED" },
      });
      const searched = (await api().get(`/api/v1/admin/complaints?search=${detail.ticketCode}`).set(as("admin")).expect(200)).body.data;
      expect(searched.items.map((item: { id: string }) => item.id)).toEqual([complaintId]);

      await api()
        .patch(`/api/v1/admin/complaints/${complaintId}`)
        .set(as("admin"))
        .send({ status: "IN_REVIEW", note: "Checking with the driver", assignToMe: true })
        .expect(200);
      const missing = await api().patch(`/api/v1/admin/complaints/${complaintId}`).set(as("admin")).send({ status: "RESOLVED" }).expect(400);
      expect(missing.body.code).toBe("VALIDATION_FAILED");
      const resolved = (
        await api()
          .patch(`/api/v1/admin/complaints/${complaintId}`)
          .set(as("admin"))
          .send({ status: "RESOLVED", resolution: "We have warned the driver. Sorry for the trouble." })
          .expect(200)
      ).body.data;
      expect(resolved).toMatchObject({ status: "RESOLVED", assignedAdmin: { name: "Ops" } });
      expect(resolved.history.map((entry: { action: string }) => entry.action)).toEqual(["CREATED", "STATUS", "ASSIGNED", "STATUS"]);

      const mine = (await api().get(`/api/v1/complaints/${complaintId}`).set(as("customerA")).expect(200)).body.data;
      expect(mine).toMatchObject({ status: "RESOLVED", resolution: "We have warned the driver. Sorry for the trouble." });
      expect(mine.timeline.map((entry: { status: string }) => entry.status)).toEqual(["OPEN", "IN_REVIEW", "RESOLVED"]);
      expect(JSON.stringify(mine)).not.toContain("Checking with the driver");
      const update = (await notificationsOf("customerA")).items[0];
      expect(update).toMatchObject({ type: "COMPLAINT_UPDATED" });

      await api().patch(`/api/v1/admin/complaints/${complaintId}`).set(as("admin")).send({ status: "CLOSED" }).expect(200);
      const reopen = await api().patch(`/api/v1/admin/complaints/${complaintId}`).set(as("admin")).send({ status: "OPEN" }).expect(409);
      expect(reopen.body.code).toBe("COMPLAINT_INVALID_TRANSITION");
      const list = (await api().get("/api/v1/complaints").set(as("customerA")).expect(200)).body.data;
      expect(list.items[0]).toMatchObject({ id: complaintId, status: "CLOSED" });
      const summary = (await api().get("/api/v1/admin/complaints/summary").set(as("admin")).expect(200)).body.data;
      expect(summary).toMatchObject({ open: 2, resolvedToday: 1 });
    });
  });
});
