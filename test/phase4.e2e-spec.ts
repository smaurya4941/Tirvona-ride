import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { getModelToken } from "@nestjs/mongoose";
import { Test } from "@nestjs/testing";
import { MongoMemoryServer } from "mongodb-memory-server";
import type { Model } from "mongoose";
import { io } from "socket.io-client";
import type { Socket } from "socket.io-client";
import request from "supertest";
import type { App } from "supertest/types";
import { RazorpayGateway, RazorpayGatewayError } from "../src/modules/payments/razorpay/razorpay.gateway";
import { razorpayPaymentSignature, razorpayWebhookSignature } from "../src/modules/payments/razorpay/razorpay-signature";
import type {
  CreateOrderInput,
  RazorpayOrder,
  RazorpayPayment,
  RazorpayPaymentStatus,
} from "../src/modules/payments/razorpay/razorpay.types";

/**
 * Phase 4 "definition of done": ride → final fare → Razorpay order →
 * checkout → server-side verification (signature + gateway + amount) →
 * ride SUCCESS → exactly one earning at the captured commission rate →
 * admin payout. Razorpay is replaced by an in-memory fake with the same
 * contract; signatures are real HMACs with the test secrets.
 */

const PASSWORD = "Password@123";
const KEY_SECRET = "e2e_key_secret_value";
const WEBHOOK_SECRET = "e2e_webhook_secret_value";
const PREM_MANDIR = { address: "Prem Mandir, Vrindavan", latitude: 27.5714, longitude: 77.6716 };
const BANKE_BIHARI = { address: "Banke Bihari Temple, Vrindavan", latitude: 27.5806, longitude: 77.7006 };
const NEAR_PICKUP = { latitude: 27.5725, longitude: 77.677 };

const PHONES = {
  admin: "+919830000000",
  customerA: "+919830000001",
  customerB: "+919830000002",
  driverA: "+919830000011",
  driverB: "+919830000012",
};
type Who = keyof typeof PHONES;

/** Razorpay with the same contract, in memory. */
class FakeRazorpay extends RazorpayGateway {
  readonly isConfigured = true;
  readonly keyId = "rzp_test_E2EKEY123";
  readonly orders = new Map<string, RazorpayOrder>();
  readonly payments = new Map<string, RazorpayPayment>();
  unreachable = false;
  ordersCreated = 0;
  private seq = 0;

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}_E2E${this.seq.toString().padStart(8, "0")}`;
  }

  private guard(): void {
    if (this.unreachable) throw new RazorpayGatewayError("Could not reach Razorpay: timeout");
  }

  async createOrder(input: CreateOrderInput): Promise<RazorpayOrder> {
    this.guard();
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
    this.ordersCreated += 1;
    return order;
  }

  async fetchPayment(paymentId: string): Promise<RazorpayPayment> {
    this.guard();
    const payment = this.payments.get(paymentId);
    if (!payment) throw new RazorpayGatewayError("The id provided does not exist", 400, "BAD_REQUEST_ERROR");
    return { ...payment };
  }

  async capturePayment(paymentId: string, amountPaise: number): Promise<RazorpayPayment> {
    this.guard();
    const payment = this.payments.get(paymentId);
    if (!payment || payment.status !== "authorized" || payment.amount !== amountPaise)
      throw new RazorpayGatewayError("Capture not allowed", 400, "BAD_REQUEST_ERROR");
    payment.status = "captured";
    payment.captured = true;
    return { ...payment };
  }

  async fetchOrderPayments(orderId: string): Promise<RazorpayPayment[]> {
    this.guard();
    return [...this.payments.values()].filter((payment) => payment.order_id === orderId).map((p) => ({ ...p }));
  }

  /** The customer completing (or failing) the checkout sheet. */
  pay(
    orderId: string,
    options: { status?: RazorpayPaymentStatus; method?: string; amount?: number } = {},
  ): RazorpayPayment {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`Unknown order ${orderId}`);
    const status = options.status ?? "captured";
    const payment: RazorpayPayment = {
      id: this.nextId("pay"),
      entity: "payment",
      amount: options.amount ?? order.amount,
      currency: order.currency,
      status,
      order_id: orderId,
      method: options.method ?? "upi",
      captured: status === "captured",
      bank: null,
      wallet: null,
      card: null,
      error_code: status === "failed" ? "BAD_REQUEST_ERROR" : null,
      error_description: status === "failed" ? "Payment failed due to incorrect UPI PIN" : null,
      created_at: Math.floor(Date.now() / 1000),
    };
    this.payments.set(payment.id, payment);
    order.status = status === "captured" ? "paid" : "attempted";
    order.attempts += 1;
    return payment;
  }
}

interface Checkout {
  payment: { id: string; amount: number; status: string; ridePaymentStatus: string };
  checkout: { key: string; orderId: string; amount: number; currency: string; name: string };
}

describe("Phase 4 — payments & earnings (e2e)", () => {
  const originalCwd = process.cwd();
  let workDir: string;
  let mongo: MongoMemoryServer;
  let app: INestApplication<App>;
  let baseUrl: string;
  const razorpay = new FakeRazorpay();
  const tokens = {} as Record<Who, string>;
  const driverProfileIds: Partial<Record<Who, string>> = {};
  let earningModel: Model<{ rideId: unknown; commissionRate: number; status: string }>;
  let paymentModel: Model<{ status: string }>;
  const sockets: Socket[] = [];

  const api = () => request(app.getHttpServer());
  const as = (who: Who) => ({ Authorization: `Bearer ${tokens[who]}` });
  const sign = (orderId: string, paymentId: string) => razorpayPaymentSignature(orderId, paymentId, KEY_SECRET);

  async function goOnline(who: Who) {
    await api().patch("/api/v1/drivers/availability").set(as(who)).send({ isOnline: true, ...NEAR_PICKUP }).expect(200);
  }

  /** Book → accept → arrive → start (OTP) → complete. Returns the completed ride. */
  async function completedRide(customer: Who, driver: Who = "driverA") {
    await goOnline(driver);
    const booked = (
      await api()
        .post("/api/v1/rides")
        .set(as(customer))
        .send({ rideType: "AUTO", pickup: PREM_MANDIR, destination: BANKE_BIHARI })
        .expect(201)
    ).body.data as { id: string; status: string };
    expect(booked.status).toBe("DRIVER_ASSIGNED");
    await api().post(`/api/v1/rides/${booked.id}/accept`).set(as(driver)).expect(200);
    await api().post(`/api/v1/rides/${booked.id}/arrived`).set(as(driver)).expect(200);
    const otp = (await api().get(`/api/v1/rides/${booked.id}`).set(as(customer)).expect(200)).body.data.otp
      .code as string;
    await api().post(`/api/v1/rides/${booked.id}/start`).set(as(driver)).send({ otp }).expect(200);
    const completed = (await api().post(`/api/v1/rides/${booked.id}/complete`).set(as(driver)).expect(200)).body
      .data as { id: string; rideCode: string; fare: { finalFare: number }; paymentStatus: string };
    return completed;
  }

  async function createPayment(customer: Who, rideId: string): Promise<Checkout> {
    return (await api().post("/api/v1/payments/create").set(as(customer)).send({ rideId }).expect(200)).body.data;
  }

  function webhook(body: unknown, options: { eventId?: string; signature?: string } = {}) {
    const raw = JSON.stringify(body);
    return api()
      .post("/api/v1/payments/webhook")
      .set("Content-Type", "application/json")
      .set("X-Razorpay-Signature", options.signature ?? razorpayWebhookSignature(raw, WEBHOOK_SECRET))
      .set("X-Razorpay-Event-Id", options.eventId ?? `evt_${randomBytes(6).toString("hex")}`)
      .send(raw);
  }

  const paymentEvent = (event: string, payment: RazorpayPayment) => ({
    entity: "event",
    event,
    contains: ["payment"],
    payload: { payment: { entity: payment } },
  });

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    workDir = await mkdtemp(join(tmpdir(), "tirvona-ride-e2e4-"));
    process.chdir(workDir);
    Object.assign(process.env, {
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      SWAGGER_ENABLED: "false",
      MONGODB_URI: mongo.getUri(),
      MONGODB_DB_NAME: "tirvona_ride_phase4",
      REDIS_URL: "",
      THROTTLE_LIMIT: "5000",
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
    baseUrl = `http://127.0.0.1:${((app.getHttpServer() as unknown as Server).address() as AddressInfo).port}`;

    const { UsersService } = await import("../src/modules/users/users.service");
    const { DriversService } = await import("../src/modules/drivers/drivers.service");
    const { UserRole } = await import("../src/common/types/user-role.enum");
    const { Vehicle, VehicleType } = await import("../src/modules/vehicles/schemas/vehicle.schema");
    const { DriverProfile, DriverStatus } = await import("../src/modules/drivers/schemas/driver-profile.schema");
    const { DriverEarning } = await import("../src/modules/earnings/schemas/driver-earning.schema");
    const { Payment } = await import("../src/modules/payments/schemas/payment.schema");

    earningModel = app.get(getModelToken(DriverEarning.name), { strict: false });
    paymentModel = app.get(getModelToken(Payment.name), { strict: false });
    const driverModel = app.get<Model<unknown>>(getModelToken(DriverProfile.name), { strict: false });
    const vehicleModel = app.get<Model<unknown>>(getModelToken(Vehicle.name), { strict: false });
    const users = app.get(UsersService, { strict: false });
    const drivers = app.get(DriversService, { strict: false });

    await users.create({ phone: PHONES.admin, password: PASSWORD, role: UserRole.ADMIN, firstName: "Ops" });
    for (const key of ["customerA", "customerB"] as const)
      await users.create({ phone: PHONES[key], password: PASSWORD, role: UserRole.CUSTOMER, firstName: key });
    for (const [key, plate] of [["driverA", "UP85CC0001"], ["driverB", "UP85CC0002"]] as const) {
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
      driverProfileIds[key] = profile._id.toString();
    }
    for (const key of Object.keys(PHONES) as Who[]) {
      const response = await api().post("/api/v1/auth/login").send({ phone: PHONES[key], password: PASSWORD }).expect(200);
      tokens[key] = response.body.data.accessToken as string;
    }
  }, 180_000);

  afterAll(async () => {
    for (const socket of sockets) socket.disconnect();
    await app?.close();
    await mongo?.stop();
    process.chdir(originalCwd);
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  // ── Ride 1: failure, retry, verification rules, idempotency ───────────

  describe("Ride 1 — pay after completion, fail, retry, succeed once", () => {
    let ride: Awaited<ReturnType<typeof completedRide>>;
    let checkout: Checkout;
    let capturedPaymentId: string;
    let customerSocket: Socket;
    const pushed: Array<{ event: string; payload: { ride?: { paymentStatus?: string } } }> = [];

    beforeAll(async () => {
      customerSocket = io(`${baseUrl}/realtime`, {
        transports: ["websocket"],
        auth: { token: tokens.customerA },
        reconnection: false,
        forceNew: true,
      });
      sockets.push(customerSocket);
      customerSocket.onAny((event: string, payload) => pushed.push({ event, payload }));
      await new Promise<void>((resolve) => customerSocket.once("connect", () => resolve()));
    });

    it("rejects payment before the ride is completed", async () => {
      await goOnline("driverA");
      const booked = (
        await api()
          .post("/api/v1/rides")
          .set(as("customerB"))
          .send({ rideType: "AUTO", pickup: PREM_MANDIR, destination: BANKE_BIHARI })
          .expect(201)
      ).body.data as { id: string };
      const response = await api().post("/api/v1/payments/create").set(as("customerB")).send({ rideId: booked.id }).expect(409);
      expect(response.body.code).toBe("PAYMENT_RIDE_NOT_COMPLETED");
      await api().post(`/api/v1/rides/${booked.id}/cancel`).set(as("customerB")).send({ reason: "Test" }).expect(200);
    });

    it("completion sets the final fare and opens the bill (paymentStatus PENDING)", async () => {
      ride = await completedRide("customerA");
      expect(ride.fare.finalFare).toBeGreaterThan(0);
      expect(ride.paymentStatus).toBe("PENDING");
    });

    it("the app cannot send an amount — the server decides it", async () => {
      const response = await api()
        .post("/api/v1/payments/create")
        .set(as("customerA"))
        .send({ rideId: ride.id, amount: 1 })
        .expect(400);
      expect(JSON.stringify(response.body)).toContain("amount");
    });

    it("only the ride's customer can pay (driver 403, other customer 404)", async () => {
      await api().post("/api/v1/payments/create").set(as("driverA")).send({ rideId: ride.id }).expect(403);
      const other = await api().post("/api/v1/payments/create").set(as("customerB")).send({ rideId: ride.id }).expect(404);
      expect(other.body.code).toBe("RIDE_NOT_FOUND");
    });

    it("creates a Razorpay order for exactly the final fare; repeated taps reuse it", async () => {
      checkout = await createPayment("customerA", ride.id);
      expect(checkout.checkout).toMatchObject({
        key: razorpay.keyId,
        amount: Math.round(ride.fare.finalFare * 100),
        currency: "INR",
        name: "Tirvona Rides",
      });
      expect(checkout.payment.amount).toBe(ride.fare.finalFare);
      expect(checkout.payment.ridePaymentStatus).toBe("ORDER_CREATED");

      const again = await createPayment("customerA", ride.id);
      expect(again.payment.id).toBe(checkout.payment.id);
      expect(again.checkout.orderId).toBe(checkout.checkout.orderId);
      expect(razorpay.ordersCreated).toBe(1);
      expect(await paymentModel.countDocuments()).toBe(1);
    });

    it("a failed checkout marks the ride FAILED and keeps it payable", async () => {
      const failed = razorpay.pay(checkout.checkout.orderId, { status: "failed" });
      const reported = (
        await api()
          .post(`/api/v1/payments/${checkout.payment.id}/failure`)
          .set(as("customerA"))
          .send({
            razorpayOrderId: checkout.checkout.orderId,
            razorpayPaymentId: failed.id,
            code: "BAD_REQUEST_ERROR",
            description: "Payment failed due to incorrect UPI PIN",
          })
          .expect(200)
      ).body.data;
      expect(reported).toMatchObject({ status: "FAILED", ridePaymentStatus: "FAILED" });
      const rideView = (await api().get(`/api/v1/rides/${ride.id}`).set(as("customerA")).expect(200)).body.data;
      expect(rideView.paymentStatus).toBe("FAILED");
      expect(rideView.payment.failureReason).toContain("UPI PIN");
    });

    it("a valid signature on a failed payment never marks it paid", async () => {
      const failed = razorpay.pay(checkout.checkout.orderId, { status: "failed" });
      const view = (
        await api()
          .post("/api/v1/payments/verify")
          .set(as("customerA"))
          .send({
            paymentId: checkout.payment.id,
            razorpayOrderId: checkout.checkout.orderId,
            razorpayPaymentId: failed.id,
            razorpaySignature: sign(checkout.checkout.orderId, failed.id),
          })
          .expect(200)
      ).body.data;
      expect(view.status).toBe("FAILED");
      expect(await earningModel.countDocuments()).toBe(0);
    });

    it("retry re-opens the same order (no duplicate records)", async () => {
      const retry = await createPayment("customerA", ride.id);
      expect(retry.payment.id).toBe(checkout.payment.id);
      expect(retry.checkout.orderId).toBe(checkout.checkout.orderId);
      expect(retry.payment.ridePaymentStatus).toBe("ORDER_CREATED");
      expect(razorpay.ordersCreated).toBe(1);
    });

    it("rejects an invalid signature", async () => {
      const paid = razorpay.pay(checkout.checkout.orderId, { status: "authorized" });
      const response = await api()
        .post("/api/v1/payments/verify")
        .set(as("customerA"))
        .send({
          paymentId: checkout.payment.id,
          razorpayOrderId: checkout.checkout.orderId,
          razorpayPaymentId: paid.id,
          razorpaySignature: "0".repeat(64),
        })
        .expect(400);
      expect(response.body.code).toBe("PAYMENT_SIGNATURE_INVALID");
      capturedPaymentId = paid.id;
    });

    it("rejects an order that is not this payment's", async () => {
      const response = await api()
        .post("/api/v1/payments/verify")
        .set(as("customerA"))
        .send({
          paymentId: checkout.payment.id,
          razorpayOrderId: "order_FOREIGN000001",
          razorpayPaymentId: capturedPaymentId,
          razorpaySignature: sign("order_FOREIGN000001", capturedPaymentId),
        })
        .expect(400);
      expect(response.body.code).toBe("PAYMENT_ORDER_MISMATCH");
    });

    it("rejects another customer verifying this payment", async () => {
      await api()
        .post("/api/v1/payments/verify")
        .set(as("customerB"))
        .send({
          paymentId: checkout.payment.id,
          razorpayOrderId: checkout.checkout.orderId,
          razorpayPaymentId: capturedPaymentId,
          razorpaySignature: sign(checkout.checkout.orderId, capturedPaymentId),
        })
        .expect(404);
    });

    it("rejects a payment whose amount differs from the fare", async () => {
      const short = razorpay.pay(checkout.checkout.orderId, { amount: 100 });
      const response = await api()
        .post("/api/v1/payments/verify")
        .set(as("customerA"))
        .send({
          paymentId: checkout.payment.id,
          razorpayOrderId: checkout.checkout.orderId,
          razorpayPaymentId: short.id,
          razorpaySignature: sign(checkout.checkout.orderId, short.id),
        })
        .expect(400);
      expect(response.body.code).toBe("PAYMENT_AMOUNT_MISMATCH");
      const rideView = (await api().get(`/api/v1/rides/${ride.id}`).set(as("customerA")).expect(200)).body.data;
      expect(rideView.paymentStatus).not.toBe("SUCCESS");
    });

    it("verifies, captures the authorised payment, and marks the ride paid", async () => {
      const view = (
        await api()
          .post("/api/v1/payments/verify")
          .set(as("customerA"))
          .send({
            paymentId: checkout.payment.id,
            razorpayOrderId: checkout.checkout.orderId,
            razorpayPaymentId: capturedPaymentId,
            razorpaySignature: sign(checkout.checkout.orderId, capturedPaymentId),
          })
          .expect(200)
      ).body.data;
      expect(view).toMatchObject({
        status: "CAPTURED",
        ridePaymentStatus: "SUCCESS",
        razorpayPaymentId: capturedPaymentId,
        method: "upi",
      });
      expect(razorpay.payments.get(capturedPaymentId)?.status).toBe("captured");

      const rideView = (await api().get(`/api/v1/rides/${ride.id}`).set(as("customerA")).expect(200)).body.data;
      expect(rideView.paymentStatus).toBe("SUCCESS");
      expect(rideView.payment).toMatchObject({ gatewayPaymentId: capturedPaymentId, amount: ride.fare.finalFare });
    });

    it("pushes ride.payment_updated to the customer", async () => {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && !pushed.some((entry) => entry.payload.ride?.paymentStatus === "SUCCESS"))
        await new Promise((resolve) => setTimeout(resolve, 50));
      const success = pushed.find((entry) => entry.payload.ride?.paymentStatus === "SUCCESS");
      expect(success?.event).toBe("ride.payment_updated");
    });

    it("creates exactly one earning at 20% commission", async () => {
      const earnings = await earningModel.find().lean();
      expect(earnings).toHaveLength(1);
      const gross = Math.round(ride.fare.finalFare * 100);
      const commission = Math.floor((gross * 2000 + 5000) / 10000);
      expect(earnings[0]).toMatchObject({
        grossFarePaise: gross,
        commissionRate: 20,
        commissionPaise: commission,
        netEarningPaise: gross - commission,
        status: "AVAILABLE",
      });
    });

    it("a duplicate verify returns the same success and creates nothing new", async () => {
      for (let i = 0; i < 2; i += 1)
        await api()
          .post("/api/v1/payments/verify")
          .set(as("customerA"))
          .send({
            paymentId: checkout.payment.id,
            razorpayOrderId: checkout.checkout.orderId,
            razorpayPaymentId: capturedPaymentId,
            razorpaySignature: sign(checkout.checkout.orderId, capturedPaymentId),
          })
          .expect(200);
      expect(await earningModel.countDocuments()).toBe(1);
      expect(await paymentModel.countDocuments()).toBe(1);
    });

    it("duplicate webhooks (same and different event ids) change nothing", async () => {
      const captured = razorpay.payments.get(capturedPaymentId)!;
      const body = paymentEvent("payment.captured", captured);
      const first = await webhook(body, { eventId: "evt_dup_1" }).expect(200);
      const second = await webhook(body, { eventId: "evt_dup_1" }).expect(200);
      await webhook(paymentEvent("order.paid", captured), { eventId: "evt_dup_2" }).expect(200);
      expect(first.body.data.status).toBe("PROCESSED");
      expect(second.body.data.status).toBe("DUPLICATE");
      expect(await earningModel.countDocuments()).toBe(1);
    });

    it("rejects a webhook with a bad signature", async () => {
      const response = await webhook(paymentEvent("payment.captured", razorpay.payments.get(capturedPaymentId)!), {
        signature: "f".repeat(64),
      }).expect(400);
      expect(response.body.code).toBe("PAYMENT_WEBHOOK_INVALID");
    });

    it("an already-paid ride cannot be paid again", async () => {
      const response = await api().post("/api/v1/payments/create").set(as("customerA")).send({ rideId: ride.id }).expect(409);
      expect(response.body.code).toBe("PAYMENT_ALREADY_COMPLETED");
    });

    it("customer sees the receipt and the payment in history", async () => {
      const receipt = (await api().get(`/api/v1/payments/${checkout.payment.id}`).set(as("customerA")).expect(200)).body
        .data;
      expect(receipt).toMatchObject({
        status: "CAPTURED",
        rideCode: ride.rideCode,
        driver: { name: "Rahul Driver" },
        vehicle: { registrationNumber: "UP85CC0001" },
      });
      expect(receipt.ride.fare.finalFare).toBe(ride.fare.finalFare);
      await api().get(`/api/v1/payments/${checkout.payment.id}`).set(as("customerB")).expect(404);

      const history = (await api().get("/api/v1/payments/history").set(as("customerA")).expect(200)).body.data;
      expect(history.items).toHaveLength(1);
      expect(history.items[0]).toMatchObject({ id: checkout.payment.id, status: "CAPTURED" });
    });

    it("rejects re-using this Razorpay payment for another ride", async () => {
      const second = await completedRide("customerA");
      const other = await createPayment("customerA", second.id);
      const response = await api()
        .post("/api/v1/payments/verify")
        .set(as("customerA"))
        .send({
          paymentId: other.payment.id,
          razorpayOrderId: other.checkout.orderId,
          razorpayPaymentId: capturedPaymentId,
          razorpaySignature: sign(other.checkout.orderId, capturedPaymentId),
        })
        .expect(409);
      expect(response.body.code).toBe("PAYMENT_ID_REUSED");

      // Settle it properly so later totals are predictable.
      const paid = razorpay.pay(other.checkout.orderId);
      await api()
        .post("/api/v1/payments/verify")
        .set(as("customerA"))
        .send({
          paymentId: other.payment.id,
          razorpayOrderId: other.checkout.orderId,
          razorpayPaymentId: paid.id,
          razorpaySignature: sign(other.checkout.orderId, paid.id),
        })
        .expect(200);
      expect(await earningModel.countDocuments()).toBe(2);
    });
  });

  // ── Webhook-only and gateway-outage paths ─────────────────────────────

  describe("Asynchronous confirmation", () => {
    it("the webhook alone settles a payment the app never verified", async () => {
      const ride = await completedRide("customerB");
      const checkout = await createPayment("customerB", ride.id);
      const paid = razorpay.pay(checkout.checkout.orderId, { method: "card" });
      await webhook(paymentEvent("payment.captured", paid)).expect(200);

      const rideView = (await api().get(`/api/v1/rides/${ride.id}`).set(as("customerB")).expect(200)).body.data;
      expect(rideView.paymentStatus).toBe("SUCCESS");
      expect(await earningModel.countDocuments({ rideId: ride.id })).toBe(1);

      // The late verify from the app is idempotent.
      const view = (
        await api()
          .post("/api/v1/payments/verify")
          .set(as("customerB"))
          .send({
            paymentId: checkout.payment.id,
            razorpayOrderId: checkout.checkout.orderId,
            razorpayPaymentId: paid.id,
            razorpaySignature: sign(checkout.checkout.orderId, paid.id),
          })
          .expect(200)
      ).body.data;
      expect(view).toMatchObject({ status: "CAPTURED", method: "card" });
      expect(await earningModel.countDocuments({ rideId: ride.id })).toBe(1);
    });

    it("Razorpay unreachable during verify → PROCESSING, then reconciled on read", async () => {
      const ride = await completedRide("customerB");
      const checkout = await createPayment("customerB", ride.id);
      const paid = razorpay.pay(checkout.checkout.orderId);
      razorpay.unreachable = true;
      const parked = (
        await api()
          .post("/api/v1/payments/verify")
          .set(as("customerB"))
          .send({
            paymentId: checkout.payment.id,
            razorpayOrderId: checkout.checkout.orderId,
            razorpayPaymentId: paid.id,
            razorpaySignature: sign(checkout.checkout.orderId, paid.id),
          })
          .expect(200)
      ).body.data;
      expect(parked.ridePaymentStatus).toBe("PROCESSING");
      expect(await earningModel.countDocuments({ rideId: ride.id })).toBe(0);

      // A new order must not be raised while Razorpay may hold a payment.
      const blocked = await api().post("/api/v1/payments/create").set(as("customerB")).send({ rideId: ride.id }).expect(409);
      expect(blocked.body.code).toBe("PAYMENT_IN_PROGRESS");

      razorpay.unreachable = false;
      const receipt = (await api().get(`/api/v1/payments/${checkout.payment.id}`).set(as("customerB")).expect(200)).body
        .data;
      expect(receipt).toMatchObject({ status: "CAPTURED", ridePaymentStatus: "SUCCESS" });
      expect(await earningModel.countDocuments({ rideId: ride.id })).toBe(1);
    });
  });

  // ── Commission configuration ──────────────────────────────────────────

  describe("Commission", () => {
    it("starts at the seeded 20%", async () => {
      const data = (await api().get("/api/v1/admin/commission").set(as("admin")).expect(200)).body.data;
      expect(data.current).toMatchObject({ value: 20, type: "PERCENTAGE", phase: "CURRENT", version: 1 });
    });

    it("drivers and customers cannot change it", async () => {
      await api().patch("/api/v1/admin/commission").set(as("driverA")).send({ value: 1 }).expect(403);
    });

    it("rejects back-dated or out-of-range values", async () => {
      await api().patch("/api/v1/admin/commission").set(as("admin")).send({ value: 120 }).expect(400);
      await api()
        .patch("/api/v1/admin/commission")
        .set(as("admin"))
        .send({ value: 10, effectiveFrom: "2020-01-01T00:00:00Z" })
        .expect(400);
    });

    it("a new rate applies to new earnings only; history keeps both", async () => {
      const updated = (
        await api().patch("/api/v1/admin/commission").set(as("admin")).send({ value: 15, note: "Launch offer" }).expect(200)
      ).body.data;
      expect(updated).toMatchObject({ value: 15, version: 2, phase: "CURRENT" });

      const ride = await completedRide("customerA");
      const checkout = await createPayment("customerA", ride.id);
      const paid = razorpay.pay(checkout.checkout.orderId);
      await api()
        .post("/api/v1/payments/verify")
        .set(as("customerA"))
        .send({
          paymentId: checkout.payment.id,
          razorpayOrderId: checkout.checkout.orderId,
          razorpayPaymentId: paid.id,
          razorpaySignature: sign(checkout.checkout.orderId, paid.id),
        })
        .expect(200);

      const rates = (await earningModel.find().sort({ createdAt: 1 }).lean()).map((earning) => earning.commissionRate);
      expect(rates).toEqual([20, 20, 20, 20, 15]);

      const history = (await api().get("/api/v1/admin/commission/history").set(as("admin")).expect(200)).body.data;
      expect(history.map((entry: { version: number; phase: string }) => [entry.version, entry.phase])).toEqual([
        [2, "CURRENT"],
        [1, "SUPERSEDED"],
      ]);
    });

    it("a scheduled change can be cancelled before it takes effect", async () => {
      const scheduled = (
        await api()
          .patch("/api/v1/admin/commission")
          .set(as("admin"))
          .send({ value: 18, effectiveFrom: new Date(Date.now() + 7 * 86_400_000).toISOString() })
          .expect(200)
      ).body.data;
      expect(scheduled.phase).toBe("SCHEDULED");
      const current = (await api().get("/api/v1/admin/commission").set(as("admin")).expect(200)).body.data;
      expect(current.current.value).toBe(15);
      expect(current.scheduled).toHaveLength(1);
      await api().post(`/api/v1/admin/commission/${scheduled.id}/cancel`).set(as("admin")).expect(200);
      await api().post(`/api/v1/admin/commission/${current.current.id}/cancel`).set(as("admin")).expect(409);
    });
  });

  // ── Driver earnings ───────────────────────────────────────────────────

  describe("Driver earnings", () => {
    it("summary totals match the ledger", async () => {
      const ledger = await earningModel.find().lean<Array<{ netEarningPaise: number; grossFarePaise: number }>>();
      const net = ledger.reduce((sum, entry) => sum + entry.netEarningPaise, 0) / 100;
      const data = (await api().get("/api/v1/earnings?period=today").set(as("driverA")).expect(200)).body.data;
      expect(data.summary.today).toMatchObject({ net, rides: 5 });
      expect(data.summary.week.net).toBe(net);
      expect(data.summary.total.net).toBe(net);
      expect(data.summary.balances).toEqual({ pending: 0, available: net, paid: 0, collected: 0, commissionDue: 0 });
      expect(data.items).toHaveLength(5);
      expect(data.periodTotals.net).toBe(net);
    });

    it("earning detail is the driver's own", async () => {
      const [first] = (await api().get("/api/v1/earnings").set(as("driverA")).expect(200)).body.data.items;
      const detail = (await api().get(`/api/v1/earnings/${first.id}`).set(as("driverA")).expect(200)).body.data;
      expect(detail.grossFare).toBeCloseTo(detail.commissionAmount + detail.netEarning, 2);
      await api().get(`/api/v1/earnings/${first.id}`).set(as("driverB")).expect(404);
      await api().get("/api/v1/earnings").set(as("customerA")).expect(403);
    });

    it("the dashboard shows today's net earnings", async () => {
      const dashboard = (await api().get("/api/v1/drivers/dashboard").set(as("driverA")).expect(200)).body.data;
      expect(dashboard.today.paidRides).toBe(5);
      expect(dashboard.today.earnings).toBeGreaterThan(0);
    });
  });

  // ── Admin payments, earnings and payouts ──────────────────────────────

  describe("Admin", () => {
    it("lists and filters payments", async () => {
      const all = (await api().get("/api/v1/admin/payments").set(as("admin")).expect(200)).body.data;
      expect(all.total).toBe(5);
      expect(all.items[0]).toHaveProperty("customer.phone");
      expect(all.items[0]).toHaveProperty("driver.driverCode");

      const captured = (await api().get("/api/v1/admin/payments?status=CAPTURED").set(as("admin")).expect(200)).body.data;
      expect(captured.total).toBe(5);
      const byCustomer = (
        await api().get(`/api/v1/admin/payments?customer=${encodeURIComponent(PHONES.customerB)}`).set(as("admin")).expect(200)
      ).body.data;
      expect(byCustomer.total).toBe(2);
      const byPayId = (
        await api().get(`/api/v1/admin/payments?payment=${byCustomer.items[0].razorpayPaymentId}`).set(as("admin")).expect(200)
      ).body.data;
      expect(byPayId.total).toBe(1);
      const byRide = (
        await api().get(`/api/v1/admin/payments?ride=${byCustomer.items[0].rideCode}`).set(as("admin")).expect(200)
      ).body.data;
      expect(byRide.total).toBe(1);
      const today = new Date().toISOString().slice(0, 10);
      const byDate = (await api().get(`/api/v1/admin/payments?from=2020-01-01&to=2020-01-02`).set(as("admin")).expect(200))
        .body.data;
      expect(byDate.total).toBe(0);
      expect(today).toMatch(/\d{4}-\d{2}-\d{2}/);
      await api().get("/api/v1/admin/payments").set(as("customerA")).expect(403);
    });

    it("payment detail shows attempts, audit trail and the commission split", async () => {
      const list = (await api().get(`/api/v1/admin/payments?customer=${encodeURIComponent(PHONES.customerA)}`).set(as("admin")))
        .body.data;
      const oldest = list.items[list.items.length - 1];
      const detail = (await api().get(`/api/v1/admin/payments/${oldest.id}`).set(as("admin")).expect(200)).body.data;
      expect(detail.attemptLog).toHaveLength(1);
      expect(detail.events.map((event: { type: string }) => event.type)).toEqual(
        expect.arrayContaining(["ORDER_CREATED", "PAYMENT_FAILED", "SIGNATURE_INVALID", "AMOUNT_MISMATCH", "PAYMENT_CAPTURED"]),
      );
      expect(detail.earning).toMatchObject({ commissionRate: 20, status: "AVAILABLE" });
    });

    it("summary shows collections and commission", async () => {
      const summary = (await api().get("/api/v1/admin/payments/summary").set(as("admin")).expect(200)).body.data;
      expect(summary.capturedTotal).toBe(5);
      expect(summary.capturedToday).toBe(5);
      expect(summary.commissionTotal).toBeGreaterThan(0);
      expect(summary.outstandingRides).toBe(0);
    });

    it("per-driver earnings show gross / commission / net / available / paid", async () => {
      const rows = (await api().get("/api/v1/admin/earnings").set(as("admin")).expect(200)).body.data;
      expect(rows.items).toHaveLength(1);
      const row = rows.items[0];
      expect(row.driver.driverId).toBe(driverProfileIds.driverA);
      expect(row.gross).toBeCloseTo(row.commission + row.net, 2);
      expect(row).toMatchObject({ rides: 5, available: row.net, paid: 0 });
    });

    it("marks one earning paid, then pays the rest in one payout", async () => {
      const detail = (await api().get(`/api/v1/admin/earnings/${driverProfileIds.driverA}`).set(as("admin")).expect(200)).body
        .data;
      const [first, ...rest] = detail.ledger.items as Array<{ id: string; netEarning: number }>;

      await api()
        .post(`/api/v1/admin/earnings/${first.id}/mark-paid`)
        .set(as("admin"))
        .send({ payoutReference: "BANK-SEP-24001", note: "First settlement" })
        .expect(200);
      const again = await api()
        .post(`/api/v1/admin/earnings/${first.id}/mark-paid`)
        .set(as("admin"))
        .send({ payoutReference: "BANK-SEP-24002" })
        .expect(409);
      expect(again.body.code).toBe("EARNING_NOT_AVAILABLE");

      await api()
        .post("/api/v1/admin/earnings/payouts")
        .set(as("admin"))
        .send({ driverId: driverProfileIds.driverB, earningIds: rest.map((e) => e.id), payoutReference: "BANK-X-1" })
        .expect(400);
      const payout = (
        await api()
          .post("/api/v1/admin/earnings/payouts")
          .set(as("admin"))
          .send({
            driverId: driverProfileIds.driverA,
            earningIds: rest.map((earning) => earning.id),
            payoutReference: "BANK-SEP-24003",
            note: "September weekly settlement",
          })
          .expect(201)
      ).body.data;
      const restTotal = rest.reduce((sum, earning) => sum + earning.netEarning, 0);
      expect(payout).toMatchObject({ earningCount: 4, paidBy: { name: "Ops" } });
      expect(payout.amount).toBeCloseTo(restTotal, 2);

      const after = (await api().get(`/api/v1/admin/earnings/${driverProfileIds.driverA}`).set(as("admin")).expect(200)).body
        .data;
      expect(after.summary.available).toBe(0);
      expect(after.summary.paid).toBeCloseTo(after.summary.net, 2);
      expect(after.payouts).toHaveLength(2);

      const driverView = (await api().get("/api/v1/earnings").set(as("driverA")).expect(200)).body.data;
      expect(driverView.summary.balances.available).toBe(0);
      expect(driverView.items.every((item: { status: string; payoutReference?: string }) => item.status === "PAID")).toBe(
        true,
      );
    });
  });

  // ── Cash ──────────────────────────────────────────────────────────────

  describe("Pay cash", () => {
    let ride: Awaited<ReturnType<typeof completedRide>>;
    const payCash = (who: Who, rideId: string) => api().post("/api/v1/payments/cash").set(as(who)).send({ rideId });

    beforeAll(async () => {
      // Driver A is still online from the earlier rides: send every cash ride to B.
      await api().patch("/api/v1/drivers/availability").set(as("driverA")).send({ isOnline: false }).expect(200);
      ride = await completedRide("customerA", "driverB");
    });

    it("only the ride's customer can pay it in cash", async () => {
      await payCash("driverB", ride.id).expect(403);
      await payCash("customerB", ride.id).expect(404);
    });

    it("marks the ride paid in cash for exactly the final fare, without Razorpay", async () => {
      const ordersBefore = razorpay.ordersCreated;
      const payment = (await payCash("customerA", ride.id).expect(200)).body.data;
      expect(payment).toMatchObject({
        gateway: "CASH",
        method: "cash",
        status: "CAPTURED",
        ridePaymentStatus: "SUCCESS",
        amount: ride.fare.finalFare,
      });
      expect(payment.razorpayPaymentId).toBeUndefined();
      expect(razorpay.ordersCreated).toBe(ordersBefore);

      const rideView = (await api().get(`/api/v1/rides/${ride.id}`).set(as("driverB")).expect(200)).body.data;
      expect(rideView.paymentStatus).toBe("SUCCESS");
      expect(rideView.payment).toMatchObject({ method: "cash", amount: ride.fare.finalFare });
    });

    it("cannot be paid again, in cash or online", async () => {
      expect((await payCash("customerA", ride.id).expect(409)).body.code).toBe("PAYMENT_ALREADY_COMPLETED");
      const online = await api().post("/api/v1/payments/create").set(as("customerA")).send({ rideId: ride.id }).expect(409);
      expect(online.body.code).toBe("PAYMENT_ALREADY_COMPLETED");
    });

    it("the driver's earning is COLLECTED (never paid out) and the commission is due", async () => {
      const earnings = (await api().get("/api/v1/earnings").set(as("driverB")).expect(200)).body.data;
      const line = earnings.items.find((item: { rideId: string }) => item.rideId === ride.id);
      // The rate is whatever applied at the time (the Commission tests changed it).
      expect(line).toMatchObject({ paymentMode: "CASH", paymentMethod: "cash", status: "COLLECTED" });
      expect(line.grossFare).toBeCloseTo(line.netEarning + line.commissionAmount, 2);
      expect(earnings.summary.balances).toMatchObject({
        available: 0,
        pending: 0,
        collected: line.netEarning,
        commissionDue: line.commissionAmount,
      });

      // A cash line can never be included in a payout.
      const payout = await api()
        .post("/api/v1/admin/earnings/payouts")
        .set(as("admin"))
        .send({ driverId: driverProfileIds.driverB, earningIds: [line.id], payoutReference: "BANK-CASH-1" });
      expect(payout.status).toBeGreaterThanOrEqual(400);
    });

    it("tells the driver to collect the cash", async () => {
      let titles: string[] = [];
      for (let attempt = 0; attempt < 20 && !titles.includes("Collect cash"); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const page = (await api().get("/api/v1/notifications").set(as("driverB")).expect(200)).body.data;
        titles = page.items.map((item: { title: string }) => item.title);
      }
      expect(titles).toContain("Collect cash");
    });

    it("cash supersedes an abandoned online order; completing that order later is flagged, not counted", async () => {
      const second = await completedRide("customerB", "driverB");
      const checkout = await createPayment("customerB", second.id);
      await payCash("customerB", second.id).expect(200);

      // The customer finishes the old UPI checkout anyway.
      const late = razorpay.pay(checkout.checkout.orderId);
      await webhook(paymentEvent("payment.captured", late)).expect(200);

      const stored = await paymentModel.findById(checkout.payment.id).lean().exec();
      expect(stored).toMatchObject({ gateway: "CASH", status: "CAPTURED" });
      expect((stored as unknown as { duplicateCaptures: unknown[] }).duplicateCaptures).toHaveLength(1);
      expect(await earningModel.countDocuments({ rideId: second.id })).toBe(1);
    });

    it("is refused while an online payment is still being confirmed", async () => {
      const third = await completedRide("customerB", "driverB");
      const checkout = await createPayment("customerB", third.id);
      const paid = razorpay.pay(checkout.checkout.orderId);
      razorpay.unreachable = true;
      try {
        await api()
          .post("/api/v1/payments/verify")
          .set(as("customerB"))
          .send({
            paymentId: checkout.payment.id,
            razorpayOrderId: checkout.checkout.orderId,
            razorpayPaymentId: paid.id,
            razorpaySignature: sign(checkout.checkout.orderId, paid.id),
          })
          .expect(200);
        const blocked = await payCash("customerB", third.id).expect(409);
        expect(blocked.body.code).toBe("PAYMENT_IN_PROGRESS");
      } finally {
        razorpay.unreachable = false;
      }
      // Once Razorpay answers, the online payment wins and cash stays refused.
      const receipt = (await api().get(`/api/v1/payments/${checkout.payment.id}`).set(as("customerB")).expect(200)).body.data;
      expect(receipt).toMatchObject({ gateway: "RAZORPAY", status: "CAPTURED" });
      expect((await payCash("customerB", third.id).expect(409)).body.code).toBe("PAYMENT_ALREADY_COMPLETED");
    });

    it("admin: summary separates cash from online collections; the list filters by gateway", async () => {
      const summary = (await api().get("/api/v1/admin/payments/summary").set(as("admin")).expect(200)).body.data;
      expect(summary.cashRidesTotal).toBe(2);
      expect(summary.cashTotal).toBeGreaterThan(0);
      expect(summary.capturedTotal).toBe(6); // 5 earlier online rides + the one just confirmed
      expect(summary.commissionDue).toBeGreaterThan(0);

      const cashOnly = (await api().get("/api/v1/admin/payments?gateway=CASH").set(as("admin")).expect(200)).body.data;
      expect(cashOnly.total).toBe(2);
      expect(cashOnly.items.every((item: { gateway: string; method: string }) => item.gateway === "CASH" && item.method === "cash")).toBe(true);
      await api().get("/api/v1/admin/payments?gateway=PAYTM").set(as("admin")).expect(400);

      const row = (await api().get("/api/v1/admin/earnings").set(as("admin")).expect(200)).body.data.items.find(
        (item: { driver: { driverId: string } }) => item.driver.driverId === driverProfileIds.driverB,
      );
      expect(row.paid).toBe(0);
      expect(row.available).toBeCloseTo(row.net - row.collected, 2);
      expect(row.commissionDue).toBeGreaterThan(0);
    });
  });
});
