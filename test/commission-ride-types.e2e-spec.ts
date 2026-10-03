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
 * Per-ride-type commission (docs/commission/ride-type-commission.md):
 * independent rates and versions, effective dates, conflicts, the migration
 * from the old global rate, the finalisation snapshot, and what refunds use.
 */

const PASSWORD = "Password@123";
const PHONES = { admin: "+919840000001", driver: "+919840000002" } as const;
type Who = keyof typeof PHONES;

const DAY = 86_400_000;

describe("Ride-type commission (e2e)", () => {
  const originalCwd = process.cwd();
  let workDir: string;
  let mongo: MongoMemoryServer;
  let app: INestApplication<App>;
  let db: Connection;
  const tokens = {} as Record<Who, string>;
  let adminId: string;
  // Resolved after the app boots.
  let resolve: (rideType: string, at?: Date) => Promise<{ value: number; version: number }>;
  let seedAll: () => Promise<void>;
  let ensureFor: (rideType: string) => Promise<void>;
  let record: (rideType: string, grossFarePaise: number, completedAt?: Date) => Promise<{
    earning: { commissionRate: number; commissionVersion: number; commissionPaise: number; netEarningPaise: number; paymentId: Types.ObjectId; rideId: Types.ObjectId };
    created: boolean;
  }>;
  let clawback: (paymentId: Types.ObjectId, paid: number, refund: number) => Promise<{
    status: string;
    adjustment?: { commissionRate: number; commissionReversalPaise: number; grossReversalPaise: number; amountPaise: number };
  }>;

  const api = () => request(app.getHttpServer());
  const as = (who: Who) => ({ Authorization: `Bearer ${tokens[who]}` });
  const commission = (rideType = "") => `/api/v1/admin/commission${rideType ? `/${rideType}` : ""}`;
  const set = (rideType: string, body: Record<string, unknown>) => api().patch(commission(rideType)).set(as("admin")).send(body);
  const currentOf = async (rideType: string) => (await api().get(commission(rideType)).set(as("admin")).expect(200)).body.data;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 60_000 } });
    workDir = await mkdtemp(join(tmpdir(), "tirvona-ride-commission-"));
    process.chdir(workDir);
    Object.assign(process.env, {
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      SWAGGER_ENABLED: "false",
      MONGODB_URI: mongo.getUri(),
      MONGODB_DB_NAME: "tirvona_ride_commission",
      REDIS_URL: "",
      THROTTLE_LIMIT: "5000",
      THROTTLE_AUTH_LIMIT: "1000",
      BROADCAST_WORKER_INTERVAL_MS: "0",
      PAYMENT_RECONCILE_INTERVAL_MS: "0",
      MATCHING_SWEEP_INTERVAL_MS: "0",
      DEFAULT_COMMISSION_PERCENT: "10",
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
    const { UserRole } = await import("../src/common/types/user-role.enum");
    const { CommissionService } = await import("../src/modules/earnings/commission.service");
    const { EarningsService } = await import("../src/modules/earnings/earnings.service");
    const { PaymentMode } = await import("../src/modules/earnings/interfaces/earning-status");
    const users = app.get(UsersService, { strict: false });
    const commissions = app.get(CommissionService, { strict: false });
    const earnings = app.get(EarningsService, { strict: false });
    const admin = await users.create({ phone: PHONES.admin, password: PASSWORD, role: UserRole.ADMIN, firstName: "Ops" });
    adminId = admin._id.toString();
    await users.create({ phone: PHONES.driver, password: PASSWORD, role: UserRole.DRIVER, firstName: "Rahul" });

    resolve = (rideType, at) => commissions.resolve(rideType, at);
    seedAll = () => commissions.seedAll();
    ensureFor = (rideType) => commissions.ensureForRideType(rideType);
    record = (rideType, grossFarePaise, completedAt = new Date()) =>
      earnings.recordForPayment({
        paymentId: new Types.ObjectId(),
        rideId: new Types.ObjectId(),
        driverId: new Types.ObjectId(),
        driverUserId: new Types.ObjectId(),
        rideCode: `T${randomBytes(3).toString("hex").toUpperCase()}`,
        rideType,
        rideCompletedAt: completedAt,
        grossFarePaise,
        currency: "INR",
        paymentMode: PaymentMode.ONLINE,
      }) as never;
    clawback = (paymentId, paid, refund) =>
      earnings.recordRefundClawback({
        refundId: new Types.ObjectId(),
        paymentId,
        paidAmountPaise: paid,
        refundAmountPaise: refund,
        reason: "CUSTOMER_REQUEST",
      }) as never;

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

  describe("access and shape", () => {
    it("is admin-only", async () => {
      await api().get(commission()).expect(401);
      await api().get(commission()).set(as("driver")).expect(403);
      await api().get(commission("CAB")).set(as("driver")).expect(403);
      await api().patch(commission("CAB")).set(as("driver")).send({ value: 1 }).expect(403);
      await api().post("/api/v1/admin/commission/000000000000000000000000/cancel").set(as("driver")).expect(403);
    });

    it("lists every ride type with its own current rate (seeded from DEFAULT_COMMISSION_PERCENT)", async () => {
      const rows = (await api().get(commission()).set(as("admin")).expect(200)).body.data;
      const codes = rows.map((row: { rideType: { code: string } }) => row.rideType.code);
      expect(codes).toEqual(expect.arrayContaining(["BIKE", "AUTO", "CAB"]));
      for (const row of rows) {
        expect(row.current).toMatchObject({ rideType: row.rideType.code, value: 10, version: 1, phase: "CURRENT" });
        expect(row.scheduled).toEqual([]);
      }
    });

    it("404s an unknown ride type and 400s a malformed code", async () => {
      await set("SPACESHIP", { value: 5 }).expect(404);
      await api().get(commission("spaceship")).set(as("admin")).expect(400);
    });
  });

  describe("independent rates and versions", () => {
    it("Bike 10%, Auto 12%, Cab 15%: each changes on its own and counts its own versions", async () => {
      await set("AUTO", { value: 12 }).expect(200);
      const cab = (await set("CAB", { value: 15, note: "Cab tariff" }).expect(200)).body.data;
      expect(cab).toMatchObject({ rideType: "CAB", value: 15, version: 2, note: "Cab tariff" });
      await set("CAB", { value: 16 }).expect(200);
      await set("CAB", { value: 15 }).expect(200);

      expect((await currentOf("BIKE")).current).toMatchObject({ value: 10, version: 1 });
      expect((await currentOf("AUTO")).current).toMatchObject({ value: 12, version: 2 });
      expect((await currentOf("CAB")).current).toMatchObject({ value: 15, version: 4 });
    });

    it("keeps a per-ride-type history, newest first, with each version's phase", async () => {
      const history = (await api().get(commission("CAB/history")).set(as("admin")).expect(200)).body.data;
      expect(history.map((entry: { version: number; value: number; phase: string }) => [entry.version, entry.value, entry.phase])).toEqual([
        [4, 15, "CURRENT"],
        [3, 16, "SUPERSEDED"],
        [2, 15, "SUPERSEDED"],
        [1, 10, "SUPERSEDED"],
      ]);
      const full = (await currentOf("CAB")) as { history: unknown[]; rideType: { code: string } };
      expect(full.history).toHaveLength(4);
      expect((await api().get(commission("BIKE/history")).set(as("admin")).expect(200)).body.data).toHaveLength(1);
    });

    it("rejects a change to the rate already in force", async () => {
      const response = await set("CAB", { value: 15 }).expect(400);
      expect(response.body.code).toBe("COMMISSION_UNCHANGED");
    });
  });

  describe("effective dates", () => {
    it("a scheduled rate applies exactly from its start, to that ride type only", async () => {
      const effectiveFrom = new Date(Date.now() + DAY);
      const scheduled = (await set("BIKE", { value: 13, effectiveFrom: effectiveFrom.toISOString() }).expect(200)).body.data;
      expect(scheduled).toMatchObject({ rideType: "BIKE", value: 13, phase: "SCHEDULED" });

      const bike = await currentOf("BIKE");
      expect(bike.current.value).toBe(10);
      expect(bike.scheduled).toHaveLength(1);
      expect(bike.scheduled[0]).toMatchObject({ value: 13 });

      expect((await resolve("BIKE", new Date(effectiveFrom.getTime() - 1))).value).toBe(10);
      expect((await resolve("BIKE", effectiveFrom)).value).toBe(13);
      expect((await resolve("BIKE", new Date(effectiveFrom.getTime() + 60_000))).value).toBe(13);
      // Auto and Cab are unaffected.
      expect((await resolve("AUTO", new Date(effectiveFrom.getTime() + 60_000))).value).toBe(12);
      expect((await resolve("CAB", new Date(effectiveFrom.getTime() + 60_000))).value).toBe(15);
    });

    it("rejects two versions of one ride type that start at the same instant, but not on another ride type", async () => {
      const bike = (await currentOf("BIKE")).scheduled[0] as { effectiveFrom: string };
      const clash = await set("BIKE", { value: 14, effectiveFrom: bike.effectiveFrom }).expect(409);
      expect(clash.body.code).toBe("COMMISSION_VERSION_CONFLICT");
      await set("AUTO", { value: 14, effectiveFrom: bike.effectiveFrom }).expect(200);
    });

    it("a scheduled change can be cancelled; the ride type keeps its rate; once it clashed it can be set again", async () => {
      const autoScheduled = (await currentOf("AUTO")).scheduled[0] as { id: string };
      await api().post(`/api/v1/admin/commission/${autoScheduled.id}/cancel`).set(as("admin")).expect(200);
      expect((await currentOf("AUTO")).scheduled).toEqual([]);
      const cancelled = (await api().get(commission("AUTO/history")).set(as("admin")).expect(200)).body.data;
      expect(cancelled.find((entry: { id: string }) => entry.id === autoScheduled.id).phase).toBe("CANCELLED");
      // A cancelled slot no longer blocks its start time.
      const when = new Date(Date.now() + 2 * DAY).toISOString();
      await set("AUTO", { value: 14, effectiveFrom: when }).expect(200);
    });

    it("cannot cancel a version that is already in force, or take effect in the past", async () => {
      const current = (await currentOf("CAB")).current as { id: string };
      await api().post(`/api/v1/admin/commission/${current.id}/cancel`).set(as("admin")).expect(409);
      await set("CAB", { value: 9, effectiveFrom: "2020-01-01T00:00:00Z" }).expect(400);
    });
  });

  describe("every commission change is audited", () => {
    it("records who, which ride type, old and new rate and when it takes effect", async () => {
      const logs = (await api().get("/api/v1/admin/audit-logs").query({ targetType: "COMMISSION", targetId: "CAB" }).set(as("admin")).expect(200)).body.data;
      const entry = logs.items.find((row: { metadata?: { version?: number } }) => row.metadata?.version === 3);
      expect(entry).toMatchObject({ action: "commission.update", adminId, targetId: "CAB" });
      expect(entry.metadata).toMatchObject({ rideType: "CAB", oldRate: 15, newRate: 16, scheduled: false });
      expect(entry.metadata.effectiveFrom).toBeDefined();

      const bike = (await api().get("/api/v1/admin/audit-logs").query({ targetType: "COMMISSION", targetId: "BIKE" }).set(as("admin")).expect(200)).body.data;
      expect(bike.items[0].metadata).toMatchObject({ rideType: "BIKE", oldRate: 10, newRate: 13, scheduled: true });
      const cancel = (await api().get("/api/v1/admin/audit-logs").query({ targetType: "COMMISSION", targetId: "AUTO" }).set(as("admin")).expect(200)).body.data;
      expect(cancel.items.some((row: { action: string }) => row.action === "commission.cancel")).toBe(true);
    });
  });

  describe("the split on each ride type (fare ₹500)", () => {
    it.each([
      ["BIKE", 10, 5000, 45000],
      ["AUTO", 12, 6000, 44000],
      ["CAB", 15, 7500, 42500],
    ])("%s at %s%% → Tirvona %sp, driver %sp", async (rideType, rate, tirvona, driver) => {
      const { earning } = await record(rideType, 50_000);
      expect(earning).toMatchObject({ commissionRate: rate, commissionPaise: tirvona, netEarningPaise: driver });
    });
  });

  describe("finalised rides keep the rate they were finalised at", () => {
    let oldCabPaymentId: Types.ObjectId;

    it("Cab ₹1,000 at 15%, then Cab becomes 20%: the old ride stays 15% / ₹150 / ₹850", async () => {
      const old = await record("CAB", 100_000);
      expect(old.earning).toMatchObject({ commissionRate: 15, commissionPaise: 15_000, netEarningPaise: 85_000 });

      await set("CAB", { value: 20 }).expect(200);

      // Recording the same payment again returns the stored line, unchanged.
      const again = await db.collection("driver_earnings").findOne({ paymentId: old.earning.paymentId });
      expect(again).toMatchObject({ commissionRate: 15, commissionPaise: 15_000, netEarningPaise: 85_000, commissionVersion: 4 });

      const fresh = await record("CAB", 100_000);
      expect(fresh.earning).toMatchObject({ commissionRate: 20, commissionPaise: 20_000, netEarningPaise: 80_000, commissionVersion: 5 });
      // Other ride types did not move.
      expect((await record("AUTO", 100_000)).earning.commissionRate).toBe(12);

      oldCabPaymentId = old.earning.paymentId;
    });

    it("a refund on the old ride claws back at the ride's own 15%, not the current 20%", async () => {
      const outcome = await clawback(oldCabPaymentId, 100_000, 50_000);
      expect(outcome.status).toBe("RECORDED");
      // Half the ride is refunded: half of the ₹1,000 gross and half of its ₹150 commission.
      expect(outcome.adjustment).toMatchObject({
        commissionRate: 15,
        grossReversalPaise: 50_000,
        commissionReversalPaise: 7_500,
        amountPaise: 42_500,
      });
    });

    it("the ledger line records the ride type, rate and version it was priced with", async () => {
      const earning = await db.collection("driver_earnings").findOne({ commissionVersion: 4, rideType: "CAB" });
      expect(earning).toMatchObject({ rideType: "CAB", commissionRate: 15, commissionVersion: 4 });
    });

    it("resolves by the ride's completion time: a ride finished before a scheduled change keeps the old rate even if it is paid after it", async () => {
      const startsAt = new Date(Date.now() + 3 * DAY);
      await set("CAB", { value: 25, effectiveFrom: startsAt.toISOString() }).expect(200);
      const before = await record("CAB", 100_000, new Date(startsAt.getTime() - 1_000));
      const after = await record("CAB", 100_000, new Date(startsAt.getTime() + 1_000));
      expect(before.earning).toMatchObject({ commissionRate: 20 });
      expect(after.earning).toMatchObject({ commissionRate: 25 });
    });
  });

  describe("migration from the global commission", () => {
    it("copies the old history onto every ride type, version for version, and leaves the global rows", async () => {
      const configs = db.collection("commission_configs");
      const rideTypes = db.collection("ride_types");
      await configs.deleteMany({});
      const t0 = new Date("2026-01-01T00:00:00Z");
      const t1 = new Date("2026-06-01T00:00:00Z");
      const legacy = await configs.insertMany([
        { version: 1, type: "PERCENTAGE", value: 20, effectiveFrom: t0, status: "ACTIVE", note: "Initial commission" },
        { version: 2, type: "PERCENTAGE", value: 17.5, effectiveFrom: t1, status: "ACTIVE", note: "Spring rate", createdBy: new Types.ObjectId(adminId) },
        { version: 3, type: "PERCENTAGE", value: 5, effectiveFrom: new Date(Date.now() + 30 * DAY), status: "CANCELLED", cancelledAt: new Date() },
      ]);
      expect(Object.keys(legacy.insertedIds)).toHaveLength(3);

      await seedAll();

      const codes = (await rideTypes.find().toArray()).map((rideType) => rideType.code as string);
      expect(codes.length).toBeGreaterThanOrEqual(3);
      for (const code of codes) {
        const rows = await configs.find({ rideType: code }).sort({ version: 1 }).toArray();
        expect(rows.map((row) => [row.version, row.value, row.status])).toEqual([
          [1, 20, "ACTIVE"],
          [2, 17.5, "ACTIVE"],
          [3, 5, "CANCELLED"],
        ]);
        expect((await resolve(code, new Date("2026-03-01T00:00:00Z"))).value).toBe(20);
        expect((await resolve(code)).value).toBe(17.5);
      }
      // The global rows earlier earnings pointed at are untouched.
      expect(await configs.countDocuments({ rideType: { $exists: false } })).toBe(3);
      // Idempotent: a second run adds nothing.
      await seedAll();
      expect(await configs.countDocuments({})).toBe(3 + 3 * codes.length);
    });

    it("a ride type created later starts from the same history", async () => {
      await ensureFor("PREMIUM");
      expect((await resolve("PREMIUM")).value).toBe(17.5);
      // …with its own independent version count.
      const rows = await db.collection("commission_configs").find({ rideType: "PREMIUM" }).toArray();
      expect(rows.map((row) => row.version).sort()).toEqual([1, 2, 3]);
    });

    it("before the first version of a ride type, the earliest version applies", async () => {
      expect((await resolve("BIKE", new Date("2020-01-01T00:00:00Z"))).value).toBe(20);
    });
  });
});
