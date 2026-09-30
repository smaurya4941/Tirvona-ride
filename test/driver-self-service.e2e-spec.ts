import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
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
 * Approved drivers after onboarding (docs/driver-self-service/README.md):
 * change requests for licence, vehicle and documents with admin review,
 * the address as self-service, and the driver's individual ratings.
 */

const PASSWORD = "Password@123";
const PHONES = {
  admin: "+919850000001",
  driver: "+919850000002",
  other: "+919850000003",
  pending: "+919850000004",
  customer: "+919850000005",
} as const;
type Who = keyof typeof PHONES;

/** A tiny but real PNG header — the upload filter checks type and extension. */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(64)]);

const future = (years: number): string => `${new Date().getUTCFullYear() + years}-06-30`;

describe("Driver self-service after approval (e2e)", () => {
  const originalCwd = process.cwd();
  let workDir: string;
  let mongo: MongoMemoryServer;
  let app: INestApplication<App>;
  let db: Connection;
  let settle: () => Promise<void>;
  const tokens = {} as Record<Who, string>;
  const driverIds = {} as Record<Who, string>;
  const vehicleIds = {} as Record<Who, string>;

  const api = () => request(app.getHttpServer());
  const as = (who: Who) => ({ Authorization: `Bearer ${tokens[who]}` });
  const changes = (path = "") => `/api/v1/drivers/me/change-requests${path}`;
  const admin = (path = "") => `/api/v1/admin/driver-change-requests${path}`;

  const uploadDocument = (who: Who, fields: Record<string, string>, file: Buffer | null = PNG) => {
    let call = api().post(changes("/document")).set(as(who));
    for (const [name, value] of Object.entries(fields)) call = call.field(name, value);
    return file ? call.attach("file", file, "document.png") : call;
  };

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 60_000 } });
    workDir = await mkdtemp(join(tmpdir(), "tirvona-ride-driver-self-"));
    process.chdir(workDir);
    Object.assign(process.env, {
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      SWAGGER_ENABLED: "false",
      MONGODB_URI: mongo.getUri(),
      MONGODB_DB_NAME: "tirvona_ride_driver_self_service",
      REDIS_URL: "",
      THROTTLE_LIMIT: "1000",
      THROTTLE_AUTH_LIMIT: "1000",
      BROADCAST_WORKER_INTERVAL_MS: "0",
      PAYMENT_RECONCILE_INTERVAL_MS: "0",
      MATCHING_SWEEP_INTERVAL_MS: "0",
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
    const users = app.get(UsersService, { strict: false });
    const drivers = app.get(DriversService, { strict: false });

    await users.create({ phone: PHONES.admin, password: PASSWORD, role: UserRole.ADMIN, firstName: "Ops" });
    await users.create({ phone: PHONES.customer, password: PASSWORD, role: UserRole.CUSTOMER, firstName: "Meera" });
    const plates: Partial<Record<Who, string>> = { driver: "UP85CC0001", other: "UP85CC0002", pending: "UP85CC0003" };
    for (const who of ["driver", "other", "pending"] as const) {
      const user = await users.create({ phone: PHONES[who], password: PASSWORD, role: UserRole.DRIVER, firstName: "Rahul", lastName: who });
      const profile = await drivers.createProfileForUser(user._id.toString());
      driverIds[who] = profile._id.toHexString();
      await db.collection("driver_profiles").updateOne(
        { _id: profile._id },
        {
          $set: {
            driverStatus: who === "pending" ? "PENDING" : "APPROVED",
            licenseNumber: "UP3220210012345",
            licenseExpiry: new Date(`${future(3)}T00:00:00.000Z`),
            address: "Sector 62, Noida",
          },
        },
      );
      const vehicle = await db.collection("vehicles").insertOne({
        driverId: profile._id,
        vehicleType: "AUTO",
        registrationNumber: plates[who],
        make: "Bajaj",
        vehicleModel: "RE",
        color: "Green",
        isActive: true,
      });
      vehicleIds[who] = vehicle.insertedId.toHexString();
    }

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

  // ── Licence details ────────────────────────────────────────────────────

  describe("licence details", () => {
    it("an approved driver cannot edit verified fields directly, but keeps the address self-service", async () => {
      await api().patch("/api/v1/drivers/me").set(as("driver")).send({ licenseNumber: "NEW1234" }).expect(400, /DRIVER_CHANGE_REVIEW_REQUIRED/);
      const updated = (await api().patch("/api/v1/drivers/me").set(as("driver")).send({ address: "Sector 18, Noida" }).expect(200)).body.data;
      expect(updated.address).toBe("Sector 18, Noida");
      expect(updated.driverStatus).toBe("APPROVED");
    });

    it("a change waits for review, can be replaced, and applies only when approved", async () => {
      const first = (
        await api().post(changes("/profile")).set(as("driver")).send({ licenseNumber: "up3220260099999" }).expect(201)
      ).body.data;
      expect(first).toMatchObject({
        kind: "DRIVER_PROFILE",
        label: "Licence details",
        status: "PENDING",
        changes: { licenseNumber: "UP3220260099999" },
        previous: { licenseNumber: "UP3220210012345" },
      });

      // Submitting again replaces the waiting request instead of adding one.
      const expiry = future(10);
      const second = (
        await api()
          .post(changes("/profile"))
          .set(as("driver"))
          .send({ licenseNumber: "UP3220260099999", licenseExpiry: expiry })
          .expect(201)
      ).body.data;
      const overview = (await api().get(changes()).set(as("driver")).expect(200)).body.data;
      expect(overview.pending).toHaveLength(1);
      expect(overview.pending[0].id).toBe(second.id);

      // Nothing is live yet: the driver keeps the verified licence.
      expect((await api().get("/api/v1/drivers/me").set(as("driver")).expect(200)).body.data.licenseNumber).toBe("UP3220210012345");

      const queue = (await api().get(admin()).set(as("admin")).expect(200)).body.data;
      expect(queue.items.map((item: { id: string }) => item.id)).toContain(second.id);
      expect(queue.items.find((item: { id: string }) => item.id === second.id).driver).toMatchObject({
        id: driverIds.driver,
        driverStatus: "APPROVED",
        phone: PHONES.driver,
      });

      const approved = (await api().post(admin(`/${second.id}/approve`)).set(as("admin")).expect(200)).body.data;
      expect(approved.status).toBe("APPROVED");
      const me = (await api().get("/api/v1/drivers/me").set(as("driver")).expect(200)).body.data;
      expect(me.licenseNumber).toBe("UP3220260099999");
      expect(me.licenseExpiry).toBe(`${expiry}T00:00:00.000Z`);

      // Decided once: approving or rejecting again is refused.
      await api().post(admin(`/${second.id}/approve`)).set(as("admin")).expect(409, /DRIVER_CHANGE_NOT_PENDING/);
      await api().post(admin(`/${second.id}/reject`)).set(as("admin")).send({ reason: "Too late" }).expect(409);

      await settle();
      const notification = await db.collection("notifications").findOne({ type: "DRIVER_UPDATE_APPROVED" });
      expect(notification).toMatchObject({ title: "Licence details updated" });
      const audit = await db.collection("admin_audit_logs").findOne({ action: "driver_change.approve" });
      expect(audit).toMatchObject({ targetType: "DRIVER", targetId: driverIds.driver });
    });

    it("refuses empty, past-dated and not-yet-approved requests", async () => {
      await api().post(changes("/profile")).set(as("driver")).send({ licenseNumber: "UP3220260099999" }).expect(400, /DRIVER_CHANGE_EMPTY/);
      await api().post(changes("/profile")).set(as("driver")).send({}).expect(400, /DRIVER_CHANGE_EMPTY/);
      await api().post(changes("/profile")).set(as("driver")).send({ licenseExpiry: "2020-01-01" }).expect(400);
      await api().post(changes("/profile")).set(as("pending")).send({ licenseNumber: "UP1111111" }).expect(400, /INVALID_DRIVER_STATUS/);
      await api().post(changes("/profile")).set(as("customer")).send({ licenseNumber: "UP1111111" }).expect(403);
    });
  });

  // ── Vehicle ────────────────────────────────────────────────────────────

  describe("vehicle details", () => {
    it("applies an approved vehicle change; a rejection keeps the vehicle and tells the driver why", async () => {
      const change = (
        await api()
          .post(changes("/vehicle"))
          .set(as("driver"))
          .send({ vehicleId: vehicleIds.driver, color: "Yellow", manufactureYear: 2024, make: "Bajaj" })
          .expect(201)
      ).body.data;
      // Unchanged fields are dropped from the request.
      expect(change.changes).toEqual({ color: "Yellow", manufactureYear: 2024 });
      expect(change.previous).toEqual({ color: "Green", manufactureYear: null });

      const rejected = (
        await api().post(admin(`/${change.id}/reject`)).set(as("admin")).send({ reason: "Upload the new RC first" }).expect(200)
      ).body.data;
      expect(rejected).toMatchObject({ status: "REJECTED", reviewNote: "Upload the new RC first" });
      expect((await db.collection("vehicles").findOne({ _id: new Types.ObjectId(vehicleIds.driver) }))?.color).toBe("Green");
      const history = (await api().get(changes()).set(as("driver")).expect(200)).body.data.history;
      expect(history[0]).toMatchObject({ id: change.id, status: "REJECTED", reviewNote: "Upload the new RC first" });

      const again = (
        await api().post(changes("/vehicle")).set(as("driver")).send({ vehicleId: vehicleIds.driver, color: "Yellow" }).expect(201)
      ).body.data;
      await api().post(admin(`/${again.id}/approve`)).set(as("admin")).expect(200);
      const [vehicle] = (await api().get("/api/v1/vehicles/my").set(as("driver")).expect(200)).body.data;
      expect(vehicle.color).toBe("Yellow");
    });

    it("guards the registration plate, at request and at approval time", async () => {
      await api()
        .post(changes("/vehicle"))
        .set(as("driver"))
        .send({ vehicleId: vehicleIds.driver, registrationNumber: "UP85CC0002" })
        .expect(409, /VEHICLE_ALREADY_EXISTS/);

      const change = (
        await api()
          .post(changes("/vehicle"))
          .set(as("driver"))
          .send({ vehicleId: vehicleIds.driver, registrationNumber: "up 85 zz 7777" })
          .expect(201)
      ).body.data;
      expect(change.changes).toEqual({ registrationNumber: "UP85ZZ7777" });
      // Another vehicle took the plate while the request waited.
      await db.collection("vehicles").updateOne({ _id: new Types.ObjectId(vehicleIds.other) }, { $set: { registrationNumber: "UP85ZZ7777" } });
      await api().post(admin(`/${change.id}/approve`)).set(as("admin")).expect(409, /VEHICLE_ALREADY_EXISTS/);
      // The claim was released: the request is still waiting.
      expect((await api().get(admin(`/${change.id}`)).set(as("admin")).expect(200)).body.data.status).toBe("PENDING");
      await api().delete(changes(`/${change.id}`)).set(as("driver")).expect(200);
    });

    it("never touches another driver's vehicle", async () => {
      await api().post(changes("/vehicle")).set(as("driver")).send({ vehicleId: vehicleIds.other, color: "Red" }).expect(404, /VEHICLE_NOT_FOUND/);
      await api().post(changes("/vehicle")).set(as("driver")).send({ vehicleId: "not-an-id", color: "Red" }).expect(400);
    });
  });

  // ── Documents ──────────────────────────────────────────────────────────

  describe("documents", () => {
    it("a renewed driver document replaces the verified one only when approved", async () => {
      const documentId = (
        await db.collection("driver_documents").insertOne({
          driverId: new Types.ObjectId(driverIds.driver),
          documentType: "DRIVING_LICENSE",
          documentNumber: "OLD-1",
          filePath: join(workDir, "old-licence.png"),
          status: "PENDING",
        })
      ).insertedId;

      const change = (
        await uploadDocument("driver", { scope: "DRIVER", documentType: "DRIVING_LICENSE", documentNumber: "NEW-2", expiryDate: future(5) }).expect(201)
      ).body.data;
      expect(change).toMatchObject({ kind: "DRIVER_DOCUMENT", label: "Driving licence", hasFile: true, previous: { documentNumber: "OLD-1" } });
      const file = await api().get(changes(`/${change.id}/file`)).set(as("driver")).buffer(true).expect(200);
      expect(Buffer.compare(file.body as Buffer, PNG)).toBe(0);
      await api().get(admin(`/${change.id}/file`)).set(as("admin")).expect(200);
      expect((await db.collection("driver_documents").findOne({ _id: documentId }))?.documentNumber).toBe("OLD-1");

      await api().post(admin(`/${change.id}/approve`)).set(as("admin")).expect(200);
      const document = await db.collection("driver_documents").findOne({ _id: documentId });
      expect(document).toMatchObject({ documentNumber: "NEW-2", status: "VERIFIED" });
      expect(document?.expiryDate).toEqual(new Date(`${future(5)}T00:00:00.000Z`));
      expect(existsSync(document?.filePath as string)).toBe(true);
      const [listed] = (await api().get("/api/v1/drivers/me/documents").set(as("driver")).expect(200)).body.data;
      expect(listed).toMatchObject({ documentType: "DRIVING_LICENSE", status: "VERIFIED" });
    });

    it("a new vehicle document is created on approval; rejected uploads are deleted", async () => {
      const insurance = (
        await uploadDocument("driver", { scope: "VEHICLE", vehicleId: vehicleIds.driver, documentType: "INSURANCE", expiryDate: future(1) }).expect(201)
      ).body.data;
      expect(insurance).toMatchObject({ kind: "VEHICLE_DOCUMENT", label: "Vehicle insurance", previous: {} });
      await api().post(admin(`/${insurance.id}/approve`)).set(as("admin")).expect(200);
      const [created] = (await api().get(`/api/v1/vehicles/${vehicleIds.driver}/documents`).set(as("driver")).expect(200)).body.data;
      expect(created).toMatchObject({ documentType: "INSURANCE", status: "VERIFIED" });

      const puc = (
        await uploadDocument("driver", { scope: "VEHICLE", vehicleId: vehicleIds.driver, documentType: "POLLUTION_CERTIFICATE" }).expect(201)
      ).body.data;
      const stored = await db
        .collection("driver_change_requests")
        .findOne({ _id: new Types.ObjectId(puc.id) }, { projection: { filePath: 1 } });
      expect(existsSync(stored?.filePath as string)).toBe(true);
      await api().post(admin(`/${puc.id}/reject`)).set(as("admin")).send({ reason: "Blurred photo" }).expect(200);
      expect(existsSync(stored?.filePath as string)).toBe(false);
      await api().get(changes(`/${puc.id}/file`)).set(as("driver")).expect(404);
    });

    it("validates scope, type, vehicle, file and expiry", async () => {
      await uploadDocument("driver", { scope: "DRIVER", documentType: "RC" }).expect(400, /not a driver document/);
      await uploadDocument("driver", { scope: "VEHICLE", documentType: "AADHAAR", vehicleId: vehicleIds.driver }).expect(400, /not a vehicle document/);
      await uploadDocument("driver", { scope: "VEHICLE", documentType: "RC" }).expect(400);
      await uploadDocument("driver", { scope: "VEHICLE", documentType: "RC", vehicleId: vehicleIds.other }).expect(404);
      await uploadDocument("driver", { scope: "DRIVER", documentType: "PAN" }, null).expect(400);
      await uploadDocument("driver", { scope: "DRIVER", documentType: "PAN", expiryDate: "2001-01-01" }).expect(400);
      expect(await db.collection("driver_change_requests").countDocuments({ documentType: "PAN" })).toBe(0);
    });

    it("withdrawing removes the upload; another driver cannot see or withdraw it", async () => {
      const change = (await uploadDocument("driver", { scope: "DRIVER", documentType: "PAN", documentNumber: "ABCDE1234F" }).expect(201)).body.data;
      await api().get(changes(`/${change.id}/file`)).set(as("other")).expect(404);
      await api().delete(changes(`/${change.id}`)).set(as("other")).expect(404);
      const withdrawn = (await api().delete(changes(`/${change.id}`)).set(as("driver")).expect(200)).body.data;
      expect(withdrawn).toMatchObject({ status: "WITHDRAWN", hasFile: false });
      await api().delete(changes(`/${change.id}`)).set(as("driver")).expect(409, /DRIVER_CHANGE_NOT_PENDING/);
      await api().post(admin(`/${change.id}/approve`)).set(as("admin")).expect(409);
    });

    it("keeps the admin endpoints admin-only", async () => {
      await api().get(admin()).set(as("driver")).expect(403);
      expect((await api().get(admin("/summary")).set(as("admin")).expect(200)).body.data.pending).toEqual(expect.any(Number));
      const decided = (await api().get(admin("?status=APPROVED")).set(as("admin")).expect(200)).body.data;
      expect(decided.items.length).toBeGreaterThan(0);
      expect(decided.items.every((item: { status: string }) => item.status === "APPROVED")).toBe(true);
    });
  });

  // ── Individual ratings ─────────────────────────────────────────────────

  describe("ratings list", () => {
    it("pages through the driver's own ratings anonymously, with star and comment filters", async () => {
      const driverId = new Types.ObjectId(driverIds.driver);
      const base = Date.UTC(2026, 8, 1, 12);
      await db.collection("ratings").insertMany(
        Array.from({ length: 25 }, (_, index) => ({
          rideId: new Types.ObjectId(),
          customerId: new Types.ObjectId(),
          driverId,
          driverUserId: new Types.ObjectId(),
          rating: (index % 5) + 1,
          ...(index % 2 === 0 ? { comment: `Comment ${index}` } : {}),
          createdAt: new Date(base + index * 3_600_000),
          updatedAt: new Date(base + index * 3_600_000),
        })),
      );
      // Someone else's rating never shows up.
      await db.collection("ratings").insertOne({
        rideId: new Types.ObjectId(),
        customerId: new Types.ObjectId(),
        driverId: new Types.ObjectId(driverIds.other),
        driverUserId: new Types.ObjectId(),
        rating: 1,
        comment: "Other driver",
        createdAt: new Date(),
      });

      const first = (await api().get("/api/v1/drivers/me/ratings/reviews?limit=10").set(as("driver")).expect(200)).body.data;
      expect(first.items).toHaveLength(10);
      expect(first.items[0]).toEqual({ key: expect.any(String), rating: 5, comment: "Comment 24", ratedOn: "2026-09-02" });
      expect(Object.keys(first.items[1]).sort()).toEqual(["key", "ratedOn", "rating"]);
      // Anonymous: no ids, rides, riders or times.
      expect(JSON.stringify(first)).not.toMatch(/rideId|customerId|createdAt|T\d\d:/);

      const seen = new Set<string>(first.items.map((item: { key: string }) => item.key));
      let cursor = first.nextCursor as string | null;
      while (cursor) {
        const page = (
          await api().get(`/api/v1/drivers/me/ratings/reviews?limit=10&cursor=${cursor}`).set(as("driver")).expect(200)
        ).body.data;
        for (const item of page.items) seen.add(item.key);
        cursor = page.nextCursor;
      }
      expect(seen.size).toBe(25);

      const fives = (await api().get("/api/v1/drivers/me/ratings/reviews?stars=5&limit=50").set(as("driver")).expect(200)).body.data;
      expect(fives.items).toHaveLength(5);
      expect(fives.items.every((item: { rating: number }) => item.rating === 5)).toBe(true);
      const commented = (await api().get("/api/v1/drivers/me/ratings/reviews?withComment=true&limit=50").set(as("driver")).expect(200)).body.data;
      expect(commented.items).toHaveLength(13);
      expect(commented.nextCursor).toBeNull();

      await api().get("/api/v1/drivers/me/ratings/reviews?cursor=garbage").set(as("driver")).expect(400);
      await api().get("/api/v1/drivers/me/ratings/reviews?stars=6").set(as("driver")).expect(400);
      await api().get("/api/v1/drivers/me/ratings/reviews").set(as("customer")).expect(403);
    });
  });
});
