import { randomBytes, randomUUID } from "node:crypto";
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
import { RazorpayGateway } from "../src/modules/payments/razorpay/razorpay.gateway";
import { razorpayPaymentSignature, razorpayWebhookSignature } from "../src/modules/payments/razorpay/razorpay-signature";
import type { RazorpayPayment, RazorpayRefund } from "../src/modules/payments/razorpay/razorpay.types";
import { FakeRazorpay } from "./support/fake-razorpay";

/**
 * Razorpay integration v2 "definition of done":
 *  - final fare from the actual trip (trail distance, server-timed duration),
 *    booked-route fallback, customer-protection cap, frozen snapshot;
 *  - refunds: full / partial / idempotent / concurrent / rejected / lost
 *    response / dashboard refunds / duplicate captures / cash refused;
 *  - driver clawbacks exactly once, recovered from the next payout, waivable;
 *  - reconciliation: background sweep of silent orders, Razorpay ↔ MongoDB
 *    runs that heal what they safely can, live exceptions;
 *  - the /payments/webhook/razorpay route and the admin audit trail.
 * Razorpay is an in-memory fake with the same contract; signatures are real.
 */

const PASSWORD = "Password@123";
const KEY_SECRET = "e2e_key_secret_value";
const WEBHOOK_SECRET = "e2e_webhook_secret_value";
const PREM_MANDIR = { address: "Prem Mandir, Vrindavan", latitude: 27.5714, longitude: 77.6716 };
const BANKE_BIHARI = { address: "Banke Bihari Temple, Vrindavan", latitude: 27.5806, longitude: 77.7006 };
const NEAR_PICKUP = { latitude: 27.5725, longitude: 77.677 };
const METERS_PER_DEGREE = 111_195;

const PHONES = {
  admin: "+919840000000",
  customerA: "+919840000001",
  customerB: "+919840000002",
  driverA: "+919840000011",
  driverB: "+919840000012",
};
type Who = keyof typeof PHONES;

interface RideView {
  id: string;
  rideCode: string;
  estimatedFare?: number;
  paymentStatus: string;
  fare: {
    estimatedFare: number;
    finalFare: number;
    perKmRate: number;
    perMinuteRate: number;
    baseFare: number;
    minimumFare: number;
    final?: {
      distanceMeters: number;
      durationSeconds: number;
      distanceSource: string;
      durationSource: string;
      capApplied: boolean;
      total: number;
      payable: number;
      pricingVersion: number;
    };
  };
  payment?: { refundedAmount?: number };
}

interface Paid {
  ride: RideView;
  paymentId: string;
  razorpayPaymentId: string;
  orderId: string;
  amount: number;
}

describe("Razorpay integration v2 — final fare, refunds, clawbacks, reconciliation (e2e)", () => {
  const originalCwd = process.cwd();
  let workDir: string;
  let mongo: MongoMemoryServer;
  let app: INestApplication<App>;
  const razorpay = new FakeRazorpay();
  const tokens = {} as Record<Who, string>;
  let rideModel: Model<{ startedAt?: Date }>;
  let checkpointModel: Model<unknown>;
  let adjustmentModel: Model<{ amountPaise: number; status: string; paymentId: Types.ObjectId; refundId: Types.ObjectId }>;
  let refundModel: Model<{ status: string; razorpayRefundId?: string; createdAt: Date }>;
  let reconciler: { runOnce(now?: Date): Promise<Record<string, number | boolean>> };
  let reconciliation: { ensureDailyRun(now?: Date): Promise<boolean> };

  const api = () => request(app.getHttpServer());
  const as = (who: Who) => ({ Authorization: `Bearer ${tokens[who]}` });
  const sign = (orderId: string, paymentId: string) => razorpayPaymentSignature(orderId, paymentId, KEY_SECRET);

  async function goOnline(who: Who) {
    await api().patch("/api/v1/drivers/availability").set(as(who)).send({ isOnline: true, ...NEAR_PICKUP }).expect(200);
  }

  /** Book → accept → arrive → start (OTP), with only `driver` online so matching picks them. */
  async function startedRide(customer: Who, driver: Who): Promise<string> {
    const other: Who = driver === "driverA" ? "driverB" : "driverA";
    await api().patch("/api/v1/drivers/availability").set(as(other)).send({ isOnline: false }).expect(200);
    await goOnline(driver);
    const response = await api()
      .post("/api/v1/rides")
      .set(as(customer))
      .send({ rideType: "AUTO", pickup: PREM_MANDIR, destination: BANKE_BIHARI });
    if (response.status !== 201) throw new Error(`Booking failed: ${response.status} ${JSON.stringify(response.body)}`);
    const booked = response.body.data as { id: string; status: string };
    expect(booked.status).toBe("DRIVER_ASSIGNED");
    await api().post(`/api/v1/rides/${booked.id}/accept`).set(as(driver)).expect(200);
    await api().post(`/api/v1/rides/${booked.id}/arrived`).set(as(driver)).expect(200);
    const otp = (await api().get(`/api/v1/rides/${booked.id}`).set(as(customer)).expect(200)).body.data.otp.code as string;
    await api().post(`/api/v1/rides/${booked.id}/start`).set(as(driver)).send({ otp }).expect(200);
    return booked.id;
  }

  async function complete(rideId: string, driver: Who): Promise<RideView> {
    return (await api().post(`/api/v1/rides/${rideId}/complete`).set(as(driver)).expect(200)).body.data as RideView;
  }

  /**
   * Rewrites the ride's trip: started `minutes` ago, with a trail of fixes
   * every 15 s moving `metersPerFix` north from the pickup.
   */
  async function driveTrip(rideId: string, minutes: number, metersPerFix: number): Promise<void> {
    const startedAt = new Date(Date.now() - minutes * 60_000);
    await rideModel.updateOne({ _id: rideId }, { $set: { startedAt } }).exec();
    await checkpointModel.deleteMany({ rideId: new Types.ObjectId(rideId) }).exec();
    const ride = (await rideModel.findById(rideId).lean().exec()) as unknown as { driverId: Types.ObjectId };
    const fixes = Math.floor((minutes * 60) / 15);
    const rows = Array.from({ length: fixes + 1 }, (_, index) => ({
      rideId: new Types.ObjectId(rideId),
      driverId: ride.driverId,
      kind: index === 0 ? "STARTED" : "TRIP",
      location: {
        type: "Point",
        coordinates: [PREM_MANDIR.longitude, PREM_MANDIR.latitude + (index * metersPerFix) / METERS_PER_DEGREE],
      },
      source: "LIVE",
      recordedAt: new Date(startedAt.getTime() + index * 15_000),
    }));
    await checkpointModel.insertMany(rows);
  }

  async function paidRide(customer: Who, driver: Who): Promise<Paid> {
    const ride = await complete(await startedRide(customer, driver), driver);
    const checkout = (await api().post("/api/v1/payments/create").set(as(customer)).send({ rideId: ride.id }).expect(200)).body
      .data as { payment: { id: string }; checkout: { orderId: string } };
    const captured = razorpay.pay(checkout.checkout.orderId);
    const verified = (
      await api()
        .post("/api/v1/payments/verify")
        .set(as(customer))
        .send({
          paymentId: checkout.payment.id,
          razorpayOrderId: checkout.checkout.orderId,
          razorpayPaymentId: captured.id,
          razorpaySignature: sign(checkout.checkout.orderId, captured.id),
        })
        .expect(200)
    ).body.data as { status: string; amount: number };
    expect(verified.status).toBe("CAPTURED");
    return { ride, paymentId: checkout.payment.id, razorpayPaymentId: captured.id, orderId: checkout.checkout.orderId, amount: verified.amount };
  }

  function webhook(body: unknown, path = "/api/v1/payments/webhook") {
    const raw = JSON.stringify(body);
    return api()
      .post(path)
      .set("Content-Type", "application/json")
      .set("X-Razorpay-Signature", razorpayWebhookSignature(raw, WEBHOOK_SECRET))
      .set("X-Razorpay-Event-Id", `evt_${randomBytes(6).toString("hex")}`)
      .send(raw);
  }
  const refundEvent = (event: string, refund: RazorpayRefund) => ({
    entity: "event",
    event,
    contains: ["refund", "payment"],
    payload: { refund: { entity: refund } },
  });
  const paymentEvent = (event: string, payment: RazorpayPayment) => ({
    entity: "event",
    event,
    contains: ["payment"],
    payload: { payment: { entity: payment } },
  });

  const refund = (who: Who, paymentId: string, body: Record<string, unknown>) =>
    api()
      .post(`/api/v1/admin/payments/${paymentId}/refunds`)
      .set(as(who))
      .send({ reason: "FARE_ADJUSTMENT", note: "Driver took a longer route", idempotencyKey: randomUUID(), ...body });
  const detail = async (paymentId: string) =>
    (await api().get(`/api/v1/admin/payments/${paymentId}`).set(as("admin")).expect(200)).body.data;
  const deductionsOf = async (driver: Who): Promise<number> =>
    (await api().get("/api/v1/earnings?period=all").set(as(driver)).expect(200)).body.data.summary.balances.deductions;

  async function waitForRun(runId: string) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const run = (await api().get(`/api/v1/admin/payments/reconciliation/runs/${runId}`).set(as("admin")).expect(200)).body.data;
      if (run.status !== "RUNNING") return run;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Reconciliation run did not finish");
  }

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 60_000 } });
    workDir = await mkdtemp(join(tmpdir(), "tirvona-ride-e2e-pay2-"));
    process.chdir(workDir);
    Object.assign(process.env, {
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      SWAGGER_ENABLED: "false",
      MONGODB_URI: mongo.getUri(),
      MONGODB_DB_NAME: "tirvona_ride_payments_v2",
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
      RAZORPAY_KEY_ID: razorpay.keyId,
      RAZORPAY_KEY_SECRET: KEY_SECRET,
      RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
      PAYMENT_RECONCILE_INTERVAL_MS: "0",
      DEFAULT_COMMISSION_PERCENT: "20",
      EARNINGS_HOLD_HOURS: "0",
      FINAL_FARE_MODE: "actual",
      FINAL_FARE_MAX_ESTIMATE_MULTIPLIER: "1.5",
      TRIP_METER_MAX_GAP_SECONDS: "120",
      PAYMENT_DAILY_RECONCILIATION: "true",
      PAYMENT_DAILY_RECONCILIATION_HOUR: "0",
    });

    const { AppModule } = await import("../src/app.module");
    const { configureApp } = await import("../src/app.setup");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(RazorpayGateway)
      .useValue(razorpay)
      .compile();
    app = moduleRef.createNestApplication({ logger: false, rawBody: true });
    configureApp(app);
    await app.listen(0, "127.0.0.1");

    const { UsersService } = await import("../src/modules/users/users.service");
    const { DriversService } = await import("../src/modules/drivers/drivers.service");
    const { UserRole } = await import("../src/common/types/user-role.enum");
    const { Vehicle, VehicleType } = await import("../src/modules/vehicles/schemas/vehicle.schema");
    const { DriverProfile, DriverStatus } = await import("../src/modules/drivers/schemas/driver-profile.schema");
    const { Ride } = await import("../src/modules/rides/schemas/ride.schema");
    const { DriverLocationCheckpoint } = await import("../src/modules/locations/schemas/driver-location-checkpoint.schema");
    const { DriverEarningAdjustment } = await import("../src/modules/earnings/schemas/driver-earning-adjustment.schema");
    const { PaymentRefund } = await import("../src/modules/payments/schemas/payment-refund.schema");
    const { PaymentsReconciler } = await import("../src/modules/payments/payments.reconciler");
    const { PaymentReconciliationService } = await import("../src/modules/payments/payment-reconciliation.service");

    rideModel = app.get(getModelToken(Ride.name), { strict: false });
    checkpointModel = app.get(getModelToken(DriverLocationCheckpoint.name), { strict: false });
    adjustmentModel = app.get(getModelToken(DriverEarningAdjustment.name), { strict: false });
    refundModel = app.get(getModelToken(PaymentRefund.name), { strict: false });
    reconciler = app.get(PaymentsReconciler, { strict: false });
    reconciliation = app.get(PaymentReconciliationService, { strict: false });
    const driverModel = app.get<Model<unknown>>(getModelToken(DriverProfile.name), { strict: false });
    const vehicleModel = app.get<Model<unknown>>(getModelToken(Vehicle.name), { strict: false });
    const users = app.get(UsersService, { strict: false });
    const drivers = app.get(DriversService, { strict: false });

    await users.create({ phone: PHONES.admin, password: PASSWORD, role: UserRole.ADMIN, firstName: "Ops" });
    for (const key of ["customerA", "customerB"] as const)
      await users.create({ phone: PHONES[key], password: PASSWORD, role: UserRole.CUSTOMER, firstName: key });
    for (const [key, plate] of [["driverA", "UP85DD0001"], ["driverB", "UP85DD0002"]] as const) {
      const user = await users.create({
        phone: PHONES[key],
        password: PASSWORD,
        role: UserRole.DRIVER,
        firstName: key === "driverA" ? "Rahul" : "Mohan",
        lastName: "Driver",
      });
      const profile = await drivers.createProfileForUser(user._id.toString());
      await driverModel.updateOne({ _id: profile._id }, { $set: { driverStatus: DriverStatus.APPROVED } });
      await vehicleModel.create({
        driverId: profile._id,
        vehicleType: VehicleType.AUTO,
        registrationNumber: plate,
        make: "Bajaj",
        vehicleModel: "RE",
        color: "Green",
        isActive: true,
      });
    }
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

  // ── Final fare ────────────────────────────────────────────────────────

  describe("final fare from the actual trip", () => {
    const expectedTotal = (ride: RideView) => {
      const final = ride.fare.final!;
      const paise =
        Math.round(ride.fare.baseFare * 100) +
        Math.round((ride.fare.perKmRate * 100 * final.distanceMeters) / 1000) +
        Math.round((ride.fare.perMinuteRate * 100 * final.durationSeconds) / 60);
      return Math.round(Math.max(paise, ride.fare.minimumFare * 100) / 100);
    };

    it("bills the GPS-trail distance and the server-timed duration, and freezes the breakdown", async () => {
      const rideId = await startedRide("customerA", "driverA");
      await driveTrip(rideId, 20, 30); // 80 legs × 30 m = 2.4 km in 20 min
      const ride = await complete(rideId, "driverA");
      expect(ride.fare.final).toMatchObject({ distanceSource: "ACTUAL", durationSource: "ACTUAL", capApplied: false });
      expect(ride.fare.final!.distanceMeters).toBeGreaterThanOrEqual(2380);
      expect(ride.fare.final!.distanceMeters).toBeLessThanOrEqual(2420);
      expect(Math.abs(ride.fare.final!.durationSeconds - 1200)).toBeLessThanOrEqual(5);
      expect(ride.fare.finalFare).toBe(expectedTotal(ride));
      expect(ride.fare.final!.total).toBe(ride.fare.finalFare);
      expect(ride.fare.final!.payable).toBe(ride.fare.finalFare);
      expect(ride.paymentStatus).toBe("PENDING");

      // The payment is created for the final fare, not the estimate.
      const checkout = (await api().post("/api/v1/payments/create").set(as("customerA")).send({ rideId }).expect(200)).body.data;
      expect(checkout.checkout.amount).toBe(ride.fare.finalFare * 100);
    });

    it("falls back to the booked distance when there is no usable trail", async () => {
      const rideId = await startedRide("customerA", "driverA");
      await driveTrip(rideId, 10, 30);
      await checkpointModel.deleteMany({ rideId: new Types.ObjectId(rideId) }).exec();
      const ride = await complete(rideId, "driverA");
      expect(ride.fare.final).toMatchObject({ distanceSource: "BOOKED", durationSource: "ACTUAL" });
      expect(ride.fare.finalFare).toBe(expectedTotal(ride));
    });

    it("never bills more than 1.5 × the estimate the customer accepted", async () => {
      const rideId = await startedRide("customerA", "driverA");
      await driveTrip(rideId, 40, 150); // ≈ 24 km detour
      const ride = await complete(rideId, "driverA");
      expect(ride.fare.final!.capApplied).toBe(true);
      expect(ride.fare.finalFare).toBe(Math.round(ride.fare.estimatedFare * 1.5));
    });
  });

  // ── Refunds and clawbacks ─────────────────────────────────────────────

  describe("refunds of the ride payment", () => {
    let paid: Paid;
    let firstRefund: { id: string; amount: number; status: string; razorpayRefundId: string };
    const firstKey = randomUUID();

    beforeAll(async () => {
      paid = await paidRide("customerA", "driverA");
    });

    it("only admins can refund", async () => {
      await refund("customerA", paid.paymentId, {}).expect(403);
      await refund("driverA", paid.paymentId, {}).expect(403);
    });

    it("validates the amount against what was captured", async () => {
      const tooMuch = await refund("admin", paid.paymentId, { amount: paid.amount + 1 }).expect(400);
      expect(tooMuch.body.code).toBe("REFUND_AMOUNT_INVALID");
      await refund("admin", paid.paymentId, { amount: 0.5 }).expect(400);
      await refund("admin", paid.paymentId, { reason: "EXTERNAL" }).expect(400);
      expect(razorpay.refundsCreated).toBe(0);
    });

    it("a partial refund is PENDING until Razorpay processes it; the key makes a retry safe", async () => {
      razorpay.refundSpeed = "pending";
      const amount = Math.floor(paid.amount * 0.2);
      const first = (await refund("admin", paid.paymentId, { amount, idempotencyKey: firstKey }).expect(200)).body.data;
      expect(first).toMatchObject({ amount, status: "PENDING", reason: "FARE_ADJUSTMENT", driverImpact: "PROPORTIONAL" });
      expect(first.razorpayRefundId).toMatch(/^rfnd_/);
      firstRefund = first;

      const again = (await refund("admin", paid.paymentId, { amount, idempotencyKey: firstKey }).expect(200)).body.data;
      expect(again.id).toBe(first.id);
      expect(razorpay.refundsCreated).toBe(1);

      const payment = await detail(paid.paymentId);
      expect(payment.status).toBe("CAPTURED");
      expect(payment.refund).toMatchObject({ amount: 0, pending: amount, status: "PENDING" });
      expect(payment.refundable).toBeCloseTo(paid.amount - amount, 2);

      const receipt = (await api().get(`/api/v1/payments/${paid.paymentId}`).set(as("customerA")).expect(200)).body.data;
      expect(receipt.refunds).toEqual([expect.objectContaining({ amount, status: "PENDING", reason: "Fare adjustment" })]);
      expect(await adjustmentModel.countDocuments()).toBe(0);
    });

    it("refund.processed webhook: payment and ride PARTIALLY_REFUNDED, driver clawback once", async () => {
      const processed = razorpay.processRefund(firstRefund.razorpayRefundId);
      await webhook(refundEvent("refund.processed", processed)).expect(200);
      await webhook(refundEvent("refund.processed", processed)).expect(200); // redelivery, new event id

      const payment = await detail(paid.paymentId);
      expect(payment.status).toBe("PARTIALLY_REFUNDED");
      expect(payment.ridePaymentStatus).toBe("PARTIALLY_REFUNDED");
      expect(payment.refunds[0]).toMatchObject({ status: "PROCESSED", ledgerState: "RECORDED", acquirerReference: expect.any(String) });
      expect(payment.adjustments).toHaveLength(1);

      // 20% of the payment reverses 20% of the line at its own 20% commission.
      const earning = payment.earning;
      const fraction = firstRefund.amount / paid.amount;
      const gross = Math.round(earning.grossFare * 100 * fraction);
      const commission = Math.round(earning.commissionAmount * 100 * fraction);
      expect(payment.adjustments[0]).toMatchObject({ status: "OUTSTANDING", amount: (gross - commission) / 100 });
      expect(await deductionsOf("driverA")).toBe((gross - commission) / 100);

      const ride = (await api().get(`/api/v1/rides/${paid.ride.id}`).set(as("customerA")).expect(200)).body.data;
      expect(ride.paymentStatus).toBe("PARTIALLY_REFUNDED");
      expect(ride.payment.refundedAmount).toBe(firstRefund.amount);
      expect(await adjustmentModel.countDocuments()).toBe(1);
    });

    it("two concurrent full refunds of the rest: exactly one goes through", async () => {
      razorpay.refundSpeed = "processed";
      const [a, b] = await Promise.all([refund("admin", paid.paymentId, {}), refund("admin", paid.paymentId, {})]);
      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([200, 409]);
      const winner = a.status === 200 ? a.body.data : b.body.data;
      expect(winner).toMatchObject({ status: "PROCESSED" });
      expect(winner.amount).toBeCloseTo(paid.amount - firstRefund.amount, 2);
      expect((a.status === 409 ? a : b).body.code).toBe("REFUND_NOTHING_LEFT");

      const payment = await detail(paid.paymentId);
      expect(payment.status).toBe("REFUNDED");
      expect(payment.refund).toMatchObject({ amount: paid.amount, pending: 0, status: "FULL" });
      expect(payment.refundable).toBe(0);
      expect(payment.ridePaymentStatus).toBe("REFUNDED");
      // Partial + rest reverse exactly the whole earning line.
      const clawed = payment.adjustments.reduce((sum: number, adjustment: { amount: number }) => sum + adjustment.amount, 0);
      expect(clawed).toBeCloseTo(payment.earning.netEarning, 2);
      await refund("admin", paid.paymentId, {}).expect(409);
    });

    it("every refund is in the admin audit log", async () => {
      const logs = (
        await api().get(`/api/v1/admin/audit-logs?targetType=PAYMENT&targetId=${paid.paymentId}`).set(as("admin")).expect(200)
      ).body.data.items as Array<{ action: string }>;
      expect(logs.filter((log) => log.action === "payment.refund").length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("refunds Razorpay refuses or never confirms", () => {
    let paid: Paid;

    beforeAll(async () => {
      paid = await paidRide("customerB", "driverB");
    });

    afterAll(() => {
      razorpay.refundFailure = "none";
    });

    it("a rejection is 502 REFUND_REJECTED, recorded FAILED, and frees the amount", async () => {
      razorpay.refundFailure = "reject";
      const rejected = await refund("admin", paid.paymentId, { amount: 10 }).expect(502);
      expect(rejected.body.code).toBe("REFUND_REJECTED");
      const payment = await detail(paid.paymentId);
      expect(payment.refunds[0]).toMatchObject({ status: "FAILED", failureReason: expect.stringContaining("could not be initiated") });
      expect(payment.refund.status).toBe("FAILED");
      expect(payment.refundable).toBe(paid.amount);
      const exceptions = (await api().get("/api/v1/admin/payments/exceptions").set(as("admin")).expect(200)).body.data;
      expect(exceptions.items.some((item: { kind: string }) => item.kind === "REFUND_FAILED")).toBe(true);
    });

    it("a lost response stays REQUESTED and the reconciler finds the refund at Razorpay by our id", async () => {
      razorpay.refundFailure = "lost";
      const lost = (await refund("admin", paid.paymentId, { amount: 25 }).expect(200)).body.data;
      expect(lost.status).toBe("REQUESTED");
      expect(lost.razorpayRefundId).toBeUndefined();
      razorpay.refundFailure = "none";

      const pass = await reconciler.runOnce(new Date(Date.now() + 3 * 60_000));
      expect(pass.refundsChecked).toBeGreaterThanOrEqual(1);
      const found = await refundModel.findById(lost.id).lean().exec();
      expect(found).toMatchObject({ status: "PROCESSED", razorpayRefundId: expect.stringMatching(/^rfnd_/) });
      expect((await detail(paid.paymentId)).status).toBe("PARTIALLY_REFUNDED");
    });
  });

  describe("dashboard refunds, duplicates and cash", () => {
    it("a refund made in the Razorpay dashboard is recorded and waits for review", async () => {
      const paid = await paidRide("customerB", "driverB");
      const external = razorpay.dashboardRefund(paid.razorpayPaymentId, 3000);
      await webhook(refundEvent("refund.processed", external)).expect(200);

      const review = (await api().get("/api/v1/admin/payments/refunds?needsReview=true").set(as("admin")).expect(200)).body.data;
      const pendingReview = review.items.find((item: { razorpayRefundId?: string }) => item.razorpayRefundId === external.id);
      expect(pendingReview).toMatchObject({ reason: "EXTERNAL", source: "WEBHOOK", status: "PROCESSED", needsReview: true });
      expect((await detail(paid.paymentId)).adjustments).toHaveLength(0);

      const reviewed = (
        await api()
          .post(`/api/v1/admin/payments/refunds/${pendingReview.id}/review`)
          .set(as("admin"))
          .send({ driverImpact: "PROPORTIONAL", note: "Refunded by support for a detour" })
          .expect(200)
      ).body.data;
      expect(reviewed).toMatchObject({ needsReview: false, ledgerState: "RECORDED" });
      expect((await detail(paid.paymentId)).adjustments).toHaveLength(1);
      await api()
        .post(`/api/v1/admin/payments/refunds/${pendingReview.id}/review`)
        .set(as("admin"))
        .send({ driverImpact: "NONE", note: "Second opinion" })
        .expect(409);
    });

    it("a duplicate capture is refunded whole, without touching revenue or the driver", async () => {
      const paid = await paidRide("customerA", "driverA");
      const second = razorpay.pay(paid.orderId); // the customer paid again from another device
      await webhook(paymentEvent("payment.captured", second), "/api/v1/payments/webhook/razorpay").expect(200);
      let payment = await detail(paid.paymentId);
      expect(payment.duplicateCaptures).toEqual([expect.objectContaining({ razorpayPaymentId: second.id, refundState: "NONE" })]);
      expect(payment.needsAttention).toBe(true);

      await refund("admin", paid.paymentId, { target: "DUPLICATE_CAPTURE", razorpayPaymentId: second.id, amount: 1 }).expect(400);
      const refunded = (
        await refund("admin", paid.paymentId, { target: "DUPLICATE_CAPTURE", razorpayPaymentId: second.id, reason: "CUSTOMER_SUPPORT" }).expect(200)
      ).body.data;
      expect(refunded).toMatchObject({ target: "DUPLICATE_CAPTURE", reason: "DUPLICATE_PAYMENT", driverImpact: "NONE", status: "PROCESSED" });

      payment = await detail(paid.paymentId);
      expect(payment.status).toBe("CAPTURED");
      expect(payment.duplicateCaptures[0]).toMatchObject({ refundState: "FULL", refunded: second.amount / 100 });
      expect(payment.needsAttention).toBe(false);
      expect(payment.adjustments).toHaveLength(0);
      expect(payment.refundable).toBe(paid.amount);
    });

    it("a cash payment is never refunded through Razorpay", async () => {
      const ride = await complete(await startedRide("customerB", "driverB"), "driverB");
      const cash = (await api().post("/api/v1/payments/cash").set(as("customerB")).send({ rideId: ride.id }).expect(200)).body.data;
      const refused = await refund("admin", cash.id, {}).expect(409);
      expect(refused.body.code).toBe("REFUND_NOT_SUPPORTED");
    });
  });

  describe("deductions in payouts", () => {
    it("the next payout recovers outstanding clawbacks; a deduction can be waived", async () => {
      const driverDetailPath = async (who: Who) => {
        const list = (await api().get("/api/v1/admin/earnings").set(as("admin")).expect(200)).body.data.items as Array<{
          driver: { driverId: string; phone: string };
        }>;
        return list.find((row) => row.driver.phone === PHONES[who])!.driver.driverId;
      };
      const driverId = await driverDetailPath("driverA");
      const before = (await api().get(`/api/v1/admin/earnings/${driverId}`).set(as("admin")).expect(200)).body.data;
      const outstanding = before.summary.deductions as number;
      expect(outstanding).toBeGreaterThan(0);
      const available = (before.ledger.items as Array<{ id: string; status: string; netEarning: number }>).filter(
        (earning) => earning.status === "AVAILABLE",
      );
      const earningIds = available.map((earning) => earning.id);
      const gross = available.reduce((sum, earning) => sum + earning.netEarning, 0);

      const preview = (
        await api().post("/api/v1/admin/earnings/payouts/preview").set(as("admin")).send({ driverId, earningIds }).expect(200)
      ).body.data;
      expect(preview.grossAmount).toBeCloseTo(gross, 2);
      expect(preview.deductionAmount).toBeCloseTo(outstanding, 2);
      expect(preview.amount).toBeCloseTo(gross - outstanding, 2);

      const payout = (
        await api()
          .post("/api/v1/admin/earnings/payouts")
          .set(as("admin"))
          .send({ driverId, earningIds, payoutReference: "UPI-E2E-0001" })
          .expect(201)
      ).body.data;
      expect(payout).toMatchObject({ grossAmount: preview.grossAmount, deductionAmount: preview.deductionAmount, amount: preview.amount });
      expect(await deductionsOf("driverA")).toBe(0);

      // driverB's reviewed dashboard refund: waive it.
      const driverB = await driverDetailPath("driverB");
      const detailB = (await api().get(`/api/v1/admin/earnings/${driverB}`).set(as("admin")).expect(200)).body.data;
      const open = (detailB.adjustments as Array<{ id: string; status: string }>).find((adjustment) => adjustment.status === "OUTSTANDING")!;
      const waived = (
        await api().post(`/api/v1/admin/earnings/adjustments/${open.id}/waive`).set(as("admin")).send({ note: "Not the driver's fault" }).expect(200)
      ).body.data;
      expect(waived.status).toBe("WAIVED");
      await api().post(`/api/v1/admin/earnings/adjustments/${open.id}/waive`).set(as("admin")).send({ note: "Again" }).expect(409);
    });
  });

  // ── Reconciliation ────────────────────────────────────────────────────

  describe("reconciliation", () => {
    it("a Razorpay ↔ MongoDB run heals a payment nobody told us about and ignores other apps' payments", async () => {
      const ride = await complete(await startedRide("customerA", "driverA"), "driverA");
      const checkout = (await api().post("/api/v1/payments/create").set(as("customerA")).send({ rideId: ride.id }).expect(200)).body.data;
      razorpay.pay(checkout.checkout.orderId); // app killed, webhook lost
      razorpay.foreignPayment(99_900);

      const started = await api()
        .post("/api/v1/admin/payments/reconciliation/runs")
        .set(as("admin"))
        .send({ from: new Date(Date.now() - 3_600_000).toISOString() })
        .expect(202);
      const run = await waitForRun(started.body.data.id);
      expect(run.status).toBe("COMPLETED");
      expect(run.stats.foreignPayments).toBeGreaterThanOrEqual(1);
      expect(run.exceptions).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "GATEWAY_PAID_NOT_RECORDED", healed: true })]),
      );
      const payment = await detail(checkout.payment.id);
      expect(payment.status).toBe("CAPTURED");
      expect(payment.earning).not.toBeNull();

      await api()
        .post("/api/v1/admin/payments/reconciliation/runs")
        .set(as("admin"))
        .send({ from: new Date(Date.now() - 40 * 86_400_000).toISOString() })
        .expect(400);
    });

    it("the background sweep settles an order paid silently more than 30 minutes ago", async () => {
      const ride = await complete(await startedRide("customerB", "driverB"), "driverB");
      const checkout = (await api().post("/api/v1/payments/create").set(as("customerB")).send({ rideId: ride.id }).expect(200)).body.data;
      razorpay.pay(checkout.checkout.orderId);
      const pass = await reconciler.runOnce(new Date(Date.now() + 31 * 60_000));
      expect(pass.openOrdersChecked).toBeGreaterThanOrEqual(1);
      expect((await detail(checkout.payment.id)).status).toBe("CAPTURED");
    });

    it("the daily run is created once per day", async () => {
      const first = await reconciliation.ensureDailyRun();
      const second = await reconciliation.ensureDailyRun();
      expect([first, second].filter(Boolean).length).toBeLessThanOrEqual(1);
      const runs = (await api().get("/api/v1/admin/payments/reconciliation/runs").set(as("admin")).expect(200)).body.data.items as Array<{
        id: string;
        trigger: string;
      }>;
      const daily = runs.filter((run) => run.trigger === "DAILY");
      expect(daily).toHaveLength(1);
      await waitForRun(daily[0].id);
    });

    it("the payments summary reports refunds and outstanding deductions", async () => {
      const summary = (await api().get("/api/v1/admin/payments/summary").set(as("admin")).expect(200)).body.data;
      expect(summary.refundedTotal).toBeGreaterThan(0);
      expect(summary).toEqual(
        expect.objectContaining({
          refundsPending: expect.any(Number),
          refundsFailed: expect.any(Number),
          refundsToReview: expect.any(Number),
          deductionsOutstanding: expect.any(Number),
        }),
      );
    });
  });
});
