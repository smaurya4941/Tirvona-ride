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
import { PushGateway } from "../src/modules/notifications/push/push.gateway";
import type { PushMessage, PushResult } from "../src/modules/notifications/push/push.gateway";

/**
 * Data behind the rider's Home and "Where to?" screens: admin-managed popular
 * destinations (with photos), saved Home/Work, recent destinations from ride
 * history, and the free cars drawn on the Home map.
 */

const PASSWORD = "Password@123";
const PHONES = { admin: "+919870000000", customer: "+919870000001", other: "+919870000002", driver: "+919870000011" };
const NOIDA_62 = { latitude: 28.627, longitude: 77.3727 };
const VRINDAVAN = { latitude: 27.5714, longitude: 77.6716 };

class FakePush extends PushGateway {
  readonly isConfigured = false;
  async send(tokens: string[], _message: PushMessage): Promise<PushResult[]> {
    return tokens.map((token) => ({ token, delivered: false, tokenInvalid: false }));
  }
}

/** A PNG header padded with a marker so two uploads differ byte-wise. */
function png(width: number, height: number, marker = "a", padding = 64): Buffer {
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write("IHDR", 12, "ascii");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return Buffer.concat([header, Buffer.alloc(padding, marker)]);
}

interface Suggestion {
  id: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  distanceMeters?: number;
  imagePath: string | null;
}

describe("Rider home & search data (e2e)", () => {
  const originalCwd = process.cwd();
  let workDir: string;
  let mongo: MongoMemoryServer;
  let app: INestApplication<App>;
  let db: Connection;
  const tokens: Record<string, string> = {};
  const userIds: Record<string, string> = {};

  const api = () => request(app.getHttpServer());
  const as = (who: keyof typeof PHONES) => ({ Authorization: `Bearer ${tokens[who]}` });

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 60_000 } });
    workDir = await mkdtemp(join(tmpdir(), "tirvona-ride-home-"));
    process.chdir(workDir);
    Object.assign(process.env, {
      NODE_ENV: "test",
      FINAL_FARE_MODE: "booked",
      LOG_LEVEL: "silent",
      SWAGGER_ENABLED: "false",
      MONGODB_URI: mongo.getUri(),
      MONGODB_DB_NAME: "tirvona_ride_home",
      REDIS_URL: "",
      THROTTLE_LIMIT: "5000",
      THROTTLE_AUTH_LIMIT: "1000",
      THROTTLE_ADMIN_LOGIN_LIMIT: "1000",
      JWT_ACCESS_SECRET: randomBytes(48).toString("base64url"),
      JWT_REFRESH_SECRET: randomBytes(48).toString("base64url"),
      MATCHING_SWEEP_INTERVAL_MS: "0",
      PAYMENT_RECONCILE_INTERVAL_MS: "0",
      BROADCAST_WORKER_INTERVAL_MS: "0",
      PLACES_PROVIDER: "none",
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

  const popular = async (query: Record<string, number>): Promise<Suggestion[]> =>
    (await api().get("/api/v1/places/popular").query(query).set(as("customer")).expect(200)).body.data as Suggestion[];

  // ── Popular destinations ───────────────────────────────────────────────

  describe("popular destinations", () => {
    it("are seeded on first boot and served nearest first around the rider", async () => {
      const inNoida = await popular({ ...NOIDA_62, limit: 5 });
      expect(inNoida.length).toBe(5);
      expect(inNoida[0].name).toBe("Fortis Hospital");
      const distances = inNoida.map((place) => place.distanceMeters!);
      expect([...distances].sort((a, b) => a - b)).toEqual(distances);
      expect(inNoida.every((place) => place.id.startsWith("popular:") && place.imagePath === null)).toBe(true);
      expect(inNoida.some((place) => /vrindavan|mathura/i.test(place.address))).toBe(false);

      const inBraj = await popular({ ...VRINDAVAN, limit: 3 });
      expect(inBraj[0].name).toBe("Prem Mandir");
      expect(inBraj.some((place) => /noida/i.test(place.address))).toBe(false);

      // Unknown position: admin order.
      expect((await popular({ limit: 20 })).length).toBe(20);
      // Nowhere near any place (Mumbai): nothing to show.
      expect(await popular({ latitude: 19.076, longitude: 72.8777 })).toEqual([]);
    });

    it("only admins can manage them; every route is audited", async () => {
      await api().get("/api/v1/admin/popular-places").set(as("customer")).expect(403);
      await api().post("/api/v1/admin/popular-places").set(as("customer")).send({}).expect(403);

      const list = (await api().get("/api/v1/admin/popular-places").set(as("admin")).expect(200)).body.data;
      expect(list.places.length).toBeGreaterThan(20);
      expect(list.imageRule.maxBytes).toBe(1024 * 1024);

      await api().post("/api/v1/admin/popular-places").set(as("admin")).send({ name: "X" }).expect(400);
      const created = (
        await api()
          .post("/api/v1/admin/popular-places")
          .set(as("admin"))
          .send({ name: "Sector 62 Metro", secondaryText: "Sector 62, Noida", city: "Noida", latitude: 28.6217, longitude: 77.3736, sortOrder: 1 })
          .expect(201)
      ).body.data;
      expect(created).toMatchObject({ name: "Sector 62 Metro", active: true, imagePath: null });
      expect((await popular({ ...NOIDA_62, limit: 1 }))[0].name).toBe("Sector 62 Metro");

      // Hidden places disappear for riders but stay in the admin list.
      await api().patch(`/api/v1/admin/popular-places/${created.id}`).set(as("admin")).send({ active: false }).expect(200);
      expect((await popular({ ...NOIDA_62, limit: 1 }))[0].name).toBe("Fortis Hospital");

      await api().patch(`/api/v1/admin/popular-places/${new Types.ObjectId().toHexString()}`).set(as("admin")).send({ active: true }).expect(404);
      await api().delete(`/api/v1/admin/popular-places/${created.id}`).set(as("admin")).expect(200);
      await api().delete(`/api/v1/admin/popular-places/${created.id}`).set(as("admin")).expect(404);

      const audit = await db.collection("admin_audit_logs").find({ targetType: "POPULAR_PLACE" }).toArray();
      expect(audit.map((entry) => entry.action)).toEqual(
        expect.arrayContaining(["popular_place.create", "popular_place.update", "popular_place.delete"]),
      );
    });

    it("carry an admin-uploaded photo, validated by its bytes and served publicly with caching", async () => {
      const [fortis] = await popular({ ...NOIDA_62, limit: 1 });
      const id = fortis.id.replace("popular:", "");

      const bad = await api()
        .put(`/api/v1/admin/popular-places/${id}/image`)
        .set(as("admin"))
        .attach("file", Buffer.from("not an image"), { filename: "x.png", contentType: "image/png" })
        .expect(400);
      expect(bad.body.code).toBe("POPULAR_PLACE_INVALID_IMAGE");
      await api()
        .put(`/api/v1/admin/popular-places/${id}/image`)
        .set(as("admin"))
        .attach("file", png(300, 900), { filename: "tall.png", contentType: "image/png" })
        .expect(400);

      const photo = png(800, 500);
      const saved = (
        await api()
          .put(`/api/v1/admin/popular-places/${id}/image`)
          .set(as("admin"))
          .attach("file", photo, { filename: "fortis.png", contentType: "image/png" })
          .expect(200)
      ).body.data;
      expect(saved.image).toEqual({ width: 800, height: 500, bytes: photo.length });

      const [withPhoto] = await popular({ ...NOIDA_62, limit: 1 });
      expect(withPhoto.imagePath).toMatch(new RegExp(`^/places/popular/${id}/image\\?v=[0-9a-f]{16}$`));

      // No token needed; the versioned URL is immutable-cached.
      const image = await api().get(`/api/v1${withPhoto.imagePath}`).buffer(true).expect(200);
      expect(image.headers["content-type"]).toBe("image/png");
      expect(image.headers["cache-control"]).toContain("immutable");
      expect(Buffer.compare(image.body as Buffer, photo)).toBe(0);
      await api().get(`/api/v1${withPhoto.imagePath}`).set("If-None-Match", image.headers.etag).expect(304);

      await api().delete(`/api/v1/admin/popular-places/${id}/image`).set(as("admin")).expect(200);
      expect((await popular({ ...NOIDA_62, limit: 1 }))[0].imagePath).toBeNull();
      expect((await api().get(`/api/v1/places/popular/${id}/image`).expect(404)).body.code).toBe("POPULAR_PLACE_IMAGE_NOT_SET");
      await api().get("/api/v1/places/popular/not-an-id/image").expect(404);
    });
  });

  // ── Saved places ───────────────────────────────────────────────────────

  describe("saved Home / Work", () => {
    const home = { name: "Supertech Capetown", address: "Supertech Capetown, Sector 74, Noida", latitude: 28.5747, longitude: 77.3903 };

    it("start empty, are per rider, and can be set, replaced and cleared", async () => {
      expect((await api().get("/api/v1/places/saved").set(as("customer")).expect(200)).body.data).toEqual({ home: null, work: null, others: [], othersRemaining: 20 });

      const afterHome = (await api().put("/api/v1/places/saved/home").set(as("customer")).send(home).expect(200)).body.data;
      expect(afterHome.home).toMatchObject({ kind: "home", ...home });
      expect(afterHome.work).toBeNull();

      // Replacing without a name falls back to the address.
      const replaced = (
        await api()
          .put("/api/v1/places/saved/home")
          .set(as("customer"))
          .send({ address: "Sector 50, Noida", latitude: 28.5706, longitude: 77.3677 })
          .expect(200)
      ).body.data;
      expect(replaced.home).toMatchObject({ name: null, address: "Sector 50, Noida" });

      await api().put("/api/v1/places/saved/work").set(as("customer")).send({ ...home, name: "Office" }).expect(200);
      // Another rider sees nothing of this.
      expect((await api().get("/api/v1/places/saved").set(as("other")).expect(200)).body.data).toEqual({ home: null, work: null, others: [], othersRemaining: 20 });

      const cleared = (await api().delete("/api/v1/places/saved/home").set(as("customer")).expect(200)).body.data;
      expect(cleared.home).toBeNull();
      expect(cleared.work).toMatchObject({ name: "Office" });
      expect(await db.collection("saved_places").countDocuments({ userId: new Types.ObjectId(userIds.customer) })).toBe(1);
    });

    it("validate the kind and the point, and are for customers only", async () => {
      await api().put("/api/v1/places/saved/gym").set(as("customer")).send(home).expect(400);
      await api().put("/api/v1/places/saved/home").set(as("customer")).send({ ...home, latitude: 95 }).expect(400);
      await api().put("/api/v1/places/saved/home").set(as("customer")).send({ ...home, address: "" }).expect(400);
      await api().get("/api/v1/places/saved").set(as("driver")).expect(403);
      await api().get("/api/v1/places/saved").expect(401);
    });
  });

  // ── Recent destinations ────────────────────────────────────────────────

  describe("recent destinations", () => {
    it("come from the rider's own bookings, newest first, de-duplicated", async () => {
      const ride = (customer: string, address: string, point: { latitude: number; longitude: number }, minutesAgo: number) => ({
        rideCode: `TR-${randomBytes(4).toString("hex")}`,
        customerId: new Types.ObjectId(customer),
        destination: { address, ...point },
        requestedAt: new Date(Date.now() - minutesAgo * 60_000),
      });
      await db.collection("rides").insertMany([
        ride(userIds.customer, "DLF Mall of India, Sector 18, Noida", { latitude: 28.5674, longitude: 77.3211 }, 5),
        ride(userIds.customer, "Akshardham Temple, New Delhi", { latitude: 28.6125, longitude: 77.2773 }, 60),
        // Same mall, 20 m away, older: collapsed into the newest entry.
        ride(userIds.customer, "DLF Mall of India (Gate 2)", { latitude: 28.5675, longitude: 77.3212 }, 120),
        ride(userIds.other, "Somewhere private", { latitude: 28.5, longitude: 77.3 }, 1),
      ]);

      const recent = (await api().get("/api/v1/rides/recent-destinations").set(as("customer")).expect(200)).body.data;
      expect(recent.map((entry: { address: string }) => entry.address)).toEqual([
        "DLF Mall of India, Sector 18, Noida",
        "Akshardham Temple, New Delhi",
      ]);
      const one = (await api().get("/api/v1/rides/recent-destinations?limit=1").set(as("customer")).expect(200)).body.data;
      expect(one).toHaveLength(1);
      await api().get("/api/v1/rides/recent-destinations?limit=0").set(as("customer")).expect(400);
      await api().get("/api/v1/rides/recent-destinations").set(as("driver")).expect(403);
    });
  });

  // ── Nearby drivers ─────────────────────────────────────────────────────

  describe("nearby drivers", () => {
    it("shows only free, fresh, approved drivers in range, at rounded positions and without identities", async () => {
      const fresh = new Date();
      const profile = (code: string, point: { latitude: number; longitude: number }, extra: Record<string, unknown> = {}) => ({
        userId: new Types.ObjectId(),
        driverCode: code,
        driverStatus: "APPROVED",
        isOnline: true,
        isAvailable: true,
        activeVehicleType: "AUTO",
        currentLocation: { type: "Point", coordinates: [point.longitude, point.latitude] },
        locationUpdatedAt: fresh,
        ratingAverage: 0,
        ratingCount: 0,
        ratingSum: 0,
        totalRides: 0,
        ...extra,
      });
      const near = { latitude: 28.62345, longitude: 77.37012 };
      await db.collection("driver_profiles").insertMany([
        profile("DRV-NEAR", near),
        profile("DRV-CAB", { latitude: 28.63, longitude: 77.375 }, { activeVehicleType: "CAB" }),
        profile("DRV-BUSY", near, { isAvailable: false, currentRideId: new Types.ObjectId() }),
        profile("DRV-OFFLINE", near, { isOnline: false, isAvailable: false }),
        profile("DRV-STALE", near, { locationUpdatedAt: new Date(Date.now() - 24 * 3_600_000) }),
        profile("DRV-PENDING", near, { driverStatus: "PENDING" }),
        profile("DRV-FAR", { latitude: 28.5, longitude: 77.2 }),
      ]);

      const body = (await api().get("/api/v1/rides/nearby-drivers").query(NOIDA_62).set(as("customer")).expect(200)).body.data;
      expect(body.radiusMeters).toBe(3000);
      expect(body.drivers).toHaveLength(2);
      expect(body.drivers).toContainEqual({ latitude: 28.623, longitude: 77.37, vehicleType: "AUTO" });
      expect(body.drivers).toContainEqual({ latitude: 28.63, longitude: 77.375, vehicleType: "CAB" });
      expect(JSON.stringify(body)).not.toMatch(/DRV-|userId|driverId/);

      // Fare quotes carry the same supply per ride type: how many free
      // drivers of its vehicle type, and how soon the nearest could arrive.
      const quote = async (pickup: { latitude: number; longitude: number }) =>
        (
          await api()
            .post("/api/v1/rides/estimate/all")
            .set(as("customer"))
            .send({
              pickup: { address: "Sector 62, Noida", ...pickup },
              destination: { address: "DLF Mall of India, Noida", latitude: 28.5674, longitude: 77.3211 },
            })
            .expect(200)
        ).body.data as Array<{ rideType: string; pickupEtaSeconds: number | null; driversNearby: number }>;
      const quoted = await quote(NOIDA_62);
      const served = quoted.filter((estimate) => estimate.driversNearby > 0);
      expect(served.length).toBeGreaterThan(0);
      for (const estimate of served) {
        expect(estimate.pickupEtaSeconds).toBeGreaterThanOrEqual(60);
        expect(estimate.pickupEtaSeconds! % 60).toBe(0);
      }
      // Stale, busy, offline and unapproved drivers never count.
      expect(quoted.every((estimate) => estimate.driversNearby <= 1)).toBe(true);
      const far = await quote({ latitude: 28.45, longitude: 77.5 });
      expect(far.every((estimate) => estimate.pickupEtaSeconds === null && estimate.driversNearby === 0)).toBe(true);

      await api().get("/api/v1/rides/nearby-drivers").set(as("customer")).expect(400);
      await api().get("/api/v1/rides/nearby-drivers").query(NOIDA_62).set(as("driver")).expect(403);
    });
  });
});
