import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import type { App } from "supertest/types";

/**
 * Peak-hour pricing (docs/pricing/peak-pricing.md): admin slot management and
 * validation, the resolver at every time boundary, the estimate/booking
 * breakdown, and the ride's frozen price.
 */

const PASSWORD = "Password@123";
const PHONES = {
  admin: "+919890000001",
  customer: "+919890000002",
  driver: "+919890000003",
} as const;
type Who = keyof typeof PHONES;

const PREM_MANDIR = {
  address: "Prem Mandir, Vrindavan",
  latitude: 27.5714,
  longitude: 77.6716,
};
const BANKE_BIHARI = {
  address: "Banke Bihari Temple, Vrindavan",
  latitude: 27.5806,
  longitude: 77.7006,
};

/** The instant that reads `hh:mm:ss` on the IST wall clock. */
const ist = (time: string): Date =>
  new Date(`2026-10-03T${time.length === 5 ? `${time}:00` : time}+05:30`);

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

describe("Peak pricing (e2e)", () => {
  const originalCwd = process.cwd();
  let workDir: string;
  let mongo: MongoMemoryServer;
  let app: INestApplication<App>;
  const tokens = {} as Record<Who, string>;
  let priceCab: (
    at: Date,
  ) => Promise<{
    perKmRate: number;
    basePerKmRate: number;
    baseFare: number;
    perMinuteRate: number;
    minimumFare: number;
    total: number;
    distanceCharge: number;
    peak?: { name: string; hikePercent: number; surcharge: number };
  }>;
  let priceAuto: (at: Date) => Promise<{ perKmRate: number; peak?: unknown }>;

  const api = () => request(app.getHttpServer());
  const as = (who: Who) => ({ Authorization: `Bearer ${tokens[who]}` });
  const slots = (path = "") => `/api/v1/admin/peak-pricing${path}`;
  const create = (body: Record<string, unknown>) =>
    api().post(slots()).set(as("admin")).send(body);
  const trip = (rideType: string) => ({
    rideType,
    pickup: PREM_MANDIR,
    destination: BANKE_BIHARI,
  });

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create({
      instance: { launchTimeout: 60_000 },
    });
    workDir = await mkdtemp(join(tmpdir(), "tirvona-ride-peak-"));
    process.chdir(workDir);
    Object.assign(process.env, {
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      SWAGGER_ENABLED: "false",
      MONGODB_URI: mongo.getUri(),
      MONGODB_DB_NAME: "tirvona_ride_peak_pricing",
      REDIS_URL: "",
      THROTTLE_LIMIT: "5000",
      THROTTLE_AUTH_LIMIT: "1000",
      BROADCAST_WORKER_INTERVAL_MS: "0",
      PAYMENT_RECONCILE_INTERVAL_MS: "0",
      MATCHING_SWEEP_INTERVAL_MS: "0",
      MATCHING_REACTIVE_DISPATCH: "false",
      JWT_ACCESS_SECRET: randomBytes(48).toString("base64url"),
      JWT_REFRESH_SECRET: randomBytes(48).toString("base64url"),
      WHATSAPP_PROVIDER: "log",
    });

    const { AppModule } = await import("../src/app.module");
    const { configureApp } = await import("../src/app.setup");
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false, rawBody: true });
    configureApp(app);
    await app.init();

    const { UsersService } = await import("../src/modules/users/users.service");
    const { UserRole } = await import("../src/common/types/user-role.enum");
    const { PricingService } =
      await import("../src/modules/pricing/pricing.service");
    const users = app.get(UsersService, { strict: false });
    const pricing = app.get(PricingService, { strict: false });
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
      firstName: "Meera",
    });
    await users.create({
      phone: PHONES.driver,
      password: PASSWORD,
      role: UserRole.DRIVER,
      firstName: "Rahul",
    });
    // 10 km, 15 minutes: the worked example from the plan.
    priceCab = (at) => pricing.priceTrip("CAB", 10_000, 900, at);
    priceAuto = (at) => pricing.priceTrip("AUTO", 10_000, 900, at);

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

  describe("access", () => {
    it("is admin-only", async () => {
      await api().get(slots()).expect(401);
      for (const who of ["customer", "driver"] as const) {
        await api().get(slots()).set(as(who)).expect(403);
        await api().get(slots("/status")).set(as(who)).expect(403);
        await api()
          .post(slots())
          .set(as(who))
          .send({
            name: "x",
            startTime: "16:00",
            endTime: "20:00",
            hikePercent: 10,
          })
          .expect(403);
        await api()
          .patch(slots("/000000000000000000000000"))
          .set(as(who))
          .send({ hikePercent: 10 })
          .expect(403);
        await api()
          .patch(slots("/000000000000000000000000/status"))
          .set(as(who))
          .send({ isActive: false })
          .expect(403);
        await api()
          .delete(slots("/000000000000000000000000"))
          .set(as(who))
          .expect(403);
      }
    });
  });

  describe("validation", () => {
    const valid = {
      name: "Test",
      startTime: "16:00",
      endTime: "20:00",
      hikePercent: 50,
    };

    it.each([
      ["a zero hike", { hikePercent: 0 }],
      ["a negative hike", { hikePercent: -5 }],
      ["an absurd hike", { hikePercent: 301 }],
      ["three decimals", { hikePercent: 12.345 }],
      ["a bad start time", { startTime: "25:00" }],
      ["a 12-hour time", { endTime: "8:00 PM" }],
      ["equal start and end", { startTime: "16:00", endTime: "16:00" }],
      ["a missing name", { name: "" }],
      [
        "selected ride types with none chosen",
        { appliesToAll: false, rideTypes: [] },
      ],
      [
        "an unknown ride type",
        { appliesToAll: false, rideTypes: ["SPACESHIP"] },
      ],
    ])("rejects %s", async (_label, change) => {
      await create({ ...valid, ...change }).expect(400);
    });
  });

  describe("slot management", () => {
    let eveningId: string;
    let nightId: string;

    it("creates slots, including one that crosses midnight and one for a single ride type", async () => {
      const evening = (
        await create({
          name: "Evening Peak",
          startTime: "16:00",
          endTime: "20:00",
          hikePercent: 50,
        }).expect(201)
      ).body.data;
      eveningId = evening.id;
      expect(evening).toMatchObject({
        appliesToAll: true,
        rideTypes: [],
        isActive: true,
        crossesMidnight: false,
        version: 1,
      });

      const night = (
        await create({
          name: "Night Peak",
          startTime: "22:00",
          endTime: "02:00",
          hikePercent: 20,
          appliesToAll: false,
          rideTypes: ["CAB"],
        }).expect(201)
      ).body.data;
      nightId = night.id;
      expect(night).toMatchObject({
        appliesToAll: false,
        rideTypes: ["CAB"],
        crossesMidnight: true,
      });

      await create({
        name: "Morning Peak",
        startTime: "08:00",
        endTime: "10:00",
        hikePercent: 25,
      }).expect(201);
      const list = (await api().get(slots()).set(as("admin")).expect(200)).body
        .data;
      expect(list.timeZone).toBe("Asia/Kolkata");
      expect(
        list.items.map((item: { name: string }) => item.name).sort(),
      ).toEqual(["Evening Peak", "Morning Peak", "Night Peak"]);
    });

    it("rejects overlaps for a shared ride type, and duplicate names", async () => {
      const overlap = await create({
        name: "Late Evening",
        startTime: "19:00",
        endTime: "22:00",
        hikePercent: 10,
      }).expect(409);
      expect(overlap.body.code).toBe("PEAK_SLOT_OVERLAP");
      expect(overlap.body.message).toContain("Evening Peak");
      await create({
        name: "Early Morning",
        startTime: "01:00",
        endTime: "03:00",
        hikePercent: 10,
        appliesToAll: false,
        rideTypes: ["CAB"],
      }).expect(409, /PEAK_SLOT_OVERLAP/);
      // A ride type the night slot does not cover is free at that hour.
      await create({
        name: "Bike Night",
        startTime: "23:00",
        endTime: "01:00",
        hikePercent: 10,
        appliesToAll: false,
        rideTypes: ["BIKE"],
      }).expect(201);
      await create({
        name: "evening peak",
        startTime: "12:00",
        endTime: "13:00",
        hikePercent: 10,
      }).expect(409, /PEAK_SLOT_NAME_TAKEN/);
      // Back-to-back slots are fine: the end is exclusive.
      await create({
        name: "Dinner",
        startTime: "20:00",
        endTime: "21:00",
        hikePercent: 10,
      }).expect(201);
    });

    it("rejects an edit that creates an overlap, and an edit that changes nothing", async () => {
      await api()
        .patch(slots(`/${eveningId}`))
        .set(as("admin"))
        .send({ endTime: "20:30" })
        .expect(409, /PEAK_SLOT_OVERLAP/);
      await api()
        .patch(slots(`/${eveningId}`))
        .set(as("admin"))
        .send({ hikePercent: 50 })
        .expect(400);
    });

    it("edits a slot, bumps its version and records before/after in the audit log", async () => {
      const updated = (
        await api()
          .patch(slots(`/${eveningId}`))
          .set(as("admin"))
          .send({ hikePercent: 40 })
          .expect(200)
      ).body.data;
      expect(updated).toMatchObject({ hikePercent: 40, version: 2 });
      const audit = (
        await api()
          .get("/api/v1/admin/audit-logs")
          .query({ targetType: "PEAK_SLOT", targetId: eveningId })
          .set(as("admin"))
          .expect(200)
      ).body.data;
      const entry = audit.items.find(
        (row: { action: string }) => row.action === "peak_slot.update",
      );
      expect(entry.metadata).toMatchObject({
        before: { hikePercent: 50 },
        after: { hikePercent: 40 },
      });
      expect(
        audit.items.some(
          (row: { action: string }) => row.action === "peak_slot.create",
        ),
      ).toBe(true);
      await api()
        .patch(slots(`/${eveningId}`))
        .set(as("admin"))
        .send({ hikePercent: 50 })
        .expect(200);
    });

    it("only deletes disabled slots, and a disabled slot can be re-enabled only without a clash", async () => {
      await api()
        .delete(slots(`/${nightId}`))
        .set(as("admin"))
        .expect(409, /PEAK_SLOT_STILL_ACTIVE/);

      const off = (
        await api()
          .patch(slots(`/${nightId}/status`))
          .set(as("admin"))
          .send({ isActive: false })
          .expect(200)
      ).body.data;
      expect(off).toMatchObject({ isActive: false, isLive: false });
      // While it is off, the same hours can be claimed by another CAB slot…
      const replacement = (
        await create({
          name: "Night Cabs",
          startTime: "22:00",
          endTime: "00:00",
          hikePercent: 30,
          appliesToAll: false,
          rideTypes: ["CAB"],
        }).expect(201)
      ).body.data;
      // …and the original cannot come back on top of it.
      await api()
        .patch(slots(`/${nightId}/status`))
        .set(as("admin"))
        .send({ isActive: true })
        .expect(409, /PEAK_SLOT_OVERLAP/);

      await api()
        .patch(slots(`/${replacement.id}/status`))
        .set(as("admin"))
        .send({ isActive: false })
        .expect(200);
      await api()
        .patch(slots(`/${nightId}/status`))
        .set(as("admin"))
        .send({ isActive: true })
        .expect(200);
      await api()
        .patch(slots(`/${replacement.id}`))
        .set(as("admin"))
        .send({ name: "Night Cabs" })
        .expect(400);
      await api()
        .delete(slots(`/${replacement.id}`))
        .set(as("admin"))
        .expect(200);
      await api()
        .get(slots(`/${replacement.id}`))
        .set(as("admin"))
        .expect(404, /PEAK_SLOT_NOT_FOUND/);
    });
  });

  describe("pricing at every boundary (Cab ₹14/km, base ₹50, ₹2/min, minimum ₹80)", () => {
    // Slots from above: Morning 08–10 +25% (all), Evening 16–20 +50% (all), Night 22–02 +20% (CAB),
    // Bike Night 23–01 +10% (BIKE), Dinner 20–21 +10% (all).
    it.each([
      ["03:00", 14, false],
      ["07:59:59", 14, false],
      ["08:00", 17.5, true],
      ["09:30", 17.5, true],
      ["10:00", 14, false],
      ["12:00", 14, false],
      ["15:59:59", 14, false],
      ["16:00", 21, true],
      ["17:30", 21, true],
      ["19:59:59", 21, true],
      ["20:00", 15.4, true],
      ["21:00", 14, false],
      ["21:59:59", 14, false],
      ["22:00", 16.8, true],
      ["23:30", 16.8, true],
      ["00:30", 16.8, true],
      ["01:59:59", 16.8, true],
      ["02:00", 14, false],
    ])("%s → ₹%s/km (peak: %s)", async (time, perKm, isPeak) => {
      const fare = await priceCab(ist(time));
      expect(fare.perKmRate).toBe(perKm);
      expect(fare.basePerKmRate).toBe(14);
      expect(Boolean(fare.peak)).toBe(isPeak);
    });

    it("changes only the per-km component", async () => {
      const normal = await priceCab(ist("12:00"));
      const peak = await priceCab(ist("17:00"));
      expect(peak).toMatchObject({
        baseFare: normal.baseFare,
        perMinuteRate: normal.perMinuteRate,
        minimumFare: normal.minimumFare,
      });
      // ₹50 + 10 km × ₹21 + 15 min × ₹2 = ₹290, against ₹220 at normal pricing.
      expect(normal).toMatchObject({ distanceCharge: 140, total: 220 });
      expect(peak).toMatchObject({
        distanceCharge: 210,
        total: 290,
        peak: { name: "Evening Peak", hikePercent: 50, surcharge: 70 },
      });
    });

    it("scopes slots to ride types (the night slot is Cab-only)", async () => {
      expect((await priceAuto(ist("22:30"))).perKmRate).toBe(10);
      expect((await priceAuto(ist("23:30"))).perKmRate).toBe(10);
      expect((await priceAuto(ist("17:00"))).perKmRate).toBe(15);
    });

    it("ignores disabled slots", async () => {
      const morning = (
        await api().get(slots()).set(as("admin")).expect(200)
      ).body.data.items.find(
        (s: { name: string }) => s.name === "Morning Peak",
      );
      await api()
        .patch(slots(`/${morning.id}/status`))
        .set(as("admin"))
        .send({ isActive: false })
        .expect(200);
      expect((await priceCab(ist("09:00"))).perKmRate).toBe(14);
      await api()
        .patch(slots(`/${morning.id}/status`))
        .set(as("admin"))
        .send({ isActive: true })
        .expect(200);
      expect((await priceCab(ist("09:00"))).perKmRate).toBe(17.5);
    });
  });

  describe("estimate, booking and the frozen ride price", () => {
    let slotId: string;

    beforeAll(async () => {
      // Switch every slot off, then run one window that is certainly "now".
      const all = (await api().get(slots()).set(as("admin")).expect(200)).body
        .data.items as Array<{ id: string; isActive: boolean }>;
      for (const slot of all.filter((entry) => entry.isActive))
        await api()
          .patch(slots(`/${slot.id}/status`))
          .set(as("admin"))
          .send({ isActive: false })
          .expect(200);
    });

    it("prices at normal rates when no slot is in force", async () => {
      const estimate = (
        await api()
          .post("/api/v1/rides/estimate")
          .set(as("customer"))
          .send(trip("CAB"))
          .expect(200)
      ).body.data;
      expect(estimate.fare).toMatchObject({ perKmRate: 14, basePerKmRate: 14 });
      expect(estimate.fare.peak).toBeUndefined();
      const status = (
        await api().get(slots("/status")).set(as("admin")).expect(200)
      ).body.data;
      expect(status.isPeak).toBe(false);
      expect(
        status.rideTypes.find(
          (row: { rideType: string }) => row.rideType === "CAB",
        ),
      ).toMatchObject({ basePerKmRate: 14, currentPerKmRate: 14 });
    });

    it("shows the peak in the estimate once a slot covers the current time", async () => {
      slotId = (
        await create({
          name: "Right now",
          startTime: istClock(-60),
          endTime: istClock(60),
          hikePercent: 25,
        }).expect(201)
      ).body.data.id;

      const estimate = (
        await api()
          .post("/api/v1/rides/estimate")
          .set(as("customer"))
          .send(trip("CAB"))
          .expect(200)
      ).body.data;
      expect(estimate.fare).toMatchObject({
        perKmRate: 17.5,
        basePerKmRate: 14,
        peak: { name: "Right now", hikePercent: 25 },
      });
      const all = (
        await api()
          .post("/api/v1/rides/estimate/all")
          .set(as("customer"))
          .send({ pickup: PREM_MANDIR, destination: BANKE_BIHARI })
          .expect(200)
      ).body.data;
      expect(
        all.every((entry: { fare: { peak?: unknown } }) => entry.fare.peak),
      ).toBe(true);

      const status = (
        await api().get(slots("/status")).set(as("admin")).expect(200)
      ).body.data;
      expect(status.isPeak).toBe(true);
      expect(
        status.rideTypes.find(
          (row: { rideType: string }) => row.rideType === "CAB",
        ),
      ).toMatchObject({
        basePerKmRate: 14,
        currentPerKmRate: 17.5,
        peak: { name: "Right now", hikePercent: 25 },
      });
    });

    let rideId: string;
    let bookedFare: Record<string, unknown>;

    it("re-prices at confirmation and snapshots the peak on the ride", async () => {
      const response = await api()
        .post("/api/v1/rides")
        .set(as("customer"))
        .send(trip("CAB"));
      expect({ status: response.status, body: response.body }).toMatchObject({
        status: 201,
      });
      const ride = response.body.data;
      rideId = ride.id;
      bookedFare = ride.fare;
      expect(ride.fare).toMatchObject({
        perKmRate: 17.5,
        basePerKmRate: 14,
        peak: { name: "Right now", hikePercent: 25 },
      });
      expect(ride.fare.peak.surcharge).toBeGreaterThan(0);
    });

    it("keeps the ride's price when the slot is edited, disabled and deleted", async () => {
      await api()
        .patch(slots(`/${slotId}`))
        .set(as("admin"))
        .send({ hikePercent: 100 })
        .expect(200);
      await api()
        .patch(slots(`/${slotId}/status`))
        .set(as("admin"))
        .send({ isActive: false })
        .expect(200);
      await api()
        .delete(slots(`/${slotId}`))
        .set(as("admin"))
        .expect(200);

      const ride = (
        await api()
          .get(`/api/v1/rides/${rideId}`)
          .set(as("customer"))
          .expect(200)
      ).body.data;
      expect(ride.fare).toMatchObject(bookedFare);

      // New estimates are back to normal.
      const estimate = (
        await api()
          .post("/api/v1/rides/estimate")
          .set(as("customer"))
          .send(trip("CAB"))
          .expect(200)
      ).body.data;
      expect(estimate.fare.perKmRate).toBe(14);
      expect(estimate.fare.peak).toBeUndefined();
    });

    it("shows admins the frozen peak on the ride", async () => {
      const detail = (
        await api()
          .get(`/api/v1/admin/rides/${rideId}`)
          .set(as("admin"))
          .expect(200)
      ).body.data;
      expect(detail.ride.fare).toMatchObject({
        perKmRate: 17.5,
        basePerKmRate: 14,
        peak: { name: "Right now" },
      });
    });
  });
});
