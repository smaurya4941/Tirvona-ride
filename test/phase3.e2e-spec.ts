import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { getModelToken } from "@nestjs/mongoose";
import { Test } from "@nestjs/testing";
import { MongoMemoryServer } from "mongodb-memory-server";
import type { Model } from "mongoose";
import { io } from "socket.io-client";
import type { Socket } from "socket.io-client";
import request from "supertest";
import type { App } from "supertest/types";

/**
 * Phase 3 "definition of done" over real WebSockets: authenticated sockets,
 * ride-room authorization, every lifecycle event pushed (no polling), live
 * driver location relayed to the customer, arriving detection, OTP rotation,
 * reconnect recovery, reactive offer timeouts, and the MongoDB write budget
 * (no GPS-ping explosion). Hermetic: in-memory MongoDB, no Redis.
 */

const PASSWORD = "Password@123";
const PREM_MANDIR = { address: "Prem Mandir, Vrindavan", latitude: 27.5714, longitude: 77.6716 };
const BANKE_BIHARI = { address: "Banke Bihari Temple, Vrindavan", latitude: 27.5806, longitude: 77.7006 };
const NEAR_PICKUP = { latitude: 27.5725, longitude: 77.677 }; // ~0.6 km
const FAR_FROM_PICKUP = { latitude: 27.5829, longitude: 77.6987 }; // ~3 km
const AT_PICKUP = { latitude: 27.5716, longitude: 77.6717 };
const AT_DESTINATION = { latitude: BANKE_BIHARI.latitude, longitude: BANKE_BIHARI.longitude };
const ASSIGNMENT_TIMEOUT_SECONDS = 4;

const PHONES = {
  admin: "+919820000000",
  customerA: "+919820000001",
  customerB: "+919820000002",
  autoNear: "+919820000011",
  autoFar: "+919820000012",
};
type Who = keyof typeof PHONES;

interface Envelope {
  event: string;
  rideId: string;
  status?: string;
  stateVersion?: number;
  timestamp: string;
  data: Record<string, unknown>;
  ride?: Record<string, unknown> & { otp?: { code: string }; driver?: { name: string } };
}

/** A socket that records everything it receives, so no event is lost to a listener race. */
class Client {
  readonly received: Array<{ event: string; payload: Envelope }> = [];

  constructor(readonly socket: Socket) {
    socket.onAny((event: string, payload: Envelope) => this.received.push({ event, payload }));
  }

  /** Resolves with the first unconsumed matching event (already received or future). */
  async next(event: string, predicate: (payload: Envelope) => boolean = () => true, timeoutMs = 6_000): Promise<Envelope> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const index = this.received.findIndex((entry) => entry.event === event && predicate(entry.payload));
      if (index >= 0) return this.received.splice(index, 1)[0].payload;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Timed out waiting for ${event}; saw [${this.received.map((entry) => entry.event).join(", ")}]`);
  }

  /** Asserts nothing matching arrives within `ms`. */
  async none(event: string, predicate: (payload: Envelope) => boolean = () => true, ms = 600): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
    expect(this.received.filter((entry) => entry.event === event && predicate(entry.payload))).toHaveLength(0);
  }

  emit<T = Record<string, unknown>>(event: string, body: unknown): Promise<T> {
    return this.socket.timeout(5_000).emitWithAck(event, body) as Promise<T>;
  }

  close(): void {
    this.socket.disconnect();
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("Phase 3 — realtime layer (e2e)", () => {
  const originalCwd = process.cwd();
  let workDir: string;
  let mongo: MongoMemoryServer;
  let app: INestApplication<App>;
  let baseUrl: string;
  const tokens = {} as Record<Who, string>;
  const userIds = {} as Record<Who, string>;
  const driverProfileIds: Partial<Record<Who, string>> = {};
  const clients: Client[] = [];

  let rideModel: Model<{ status: string; stateVersion: number; arrivingNotifiedAt?: Date }>;
  let driverModel: Model<{ locationUpdatedAt?: Date; isOnline: boolean }>;
  let checkpointModel: Model<{ rideId: unknown; kind: string }>;
  let jwt: JwtService;

  const api = () => request(app.getHttpServer());
  const as = (who: Who) => ({ Authorization: `Bearer ${tokens[who]}` });

  function connect(token: string | undefined): Promise<Client> {
    return new Promise((resolve, reject) => {
      const socket = io(`${baseUrl}/realtime`, {
        transports: ["websocket"],
        auth: token ? { token } : {},
        reconnection: false,
        forceNew: true,
      });
      const client = new Client(socket);
      socket.once("connect", () => {
        clients.push(client);
        resolve(client);
      });
      socket.once("connect_error", (error) => {
        socket.close();
        reject(error);
      });
    });
  }

  const connectAs = (who: Who) => connect(tokens[who]);

  async function goOnline(who: Who, at: { latitude: number; longitude: number }) {
    await api().patch("/api/v1/drivers/availability").set(as(who)).send({ isOnline: true, ...at }).expect(200);
  }

  async function book(who: Who) {
    const response = await api()
      .post("/api/v1/rides")
      .set(as(who))
      .send({ rideType: "AUTO", pickup: PREM_MANDIR, destination: BANKE_BIHARI })
      .expect(201);
    return response.body.data as { id: string; status: string };
  }

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    workDir = await mkdtemp(join(tmpdir(), "tirvona-ride-e2e3-"));
    process.chdir(workDir);
    Object.assign(process.env, {
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      SWAGGER_ENABLED: "false",
      MONGODB_URI: mongo.getUri(),
      MONGODB_DB_NAME: "tirvona_ride_phase3",
      REDIS_URL: "",
      THROTTLE_LIMIT: "5000",
      JWT_ACCESS_SECRET: randomBytes(48).toString("base64url"),
      JWT_REFRESH_SECRET: randomBytes(48).toString("base64url"),
      MATCHING_SWEEP_INTERVAL_MS: "0",
      MATCHING_REACTIVE_DISPATCH: "true",
      RIDE_ASSIGNMENT_TIMEOUT_SECONDS: String(ASSIGNMENT_TIMEOUT_SECONDS),
      DRIVER_LOCATION_MIN_INTERVAL_MS: "200",
    });

    const { AppModule } = await import("../src/app.module");
    const { configureApp } = await import("../src/app.setup");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    configureApp(app);
    await app.listen(0, "127.0.0.1");
    baseUrl = `http://127.0.0.1:${((app.getHttpServer() as unknown as Server).address() as AddressInfo).port}`;

    const { UsersService } = await import("../src/modules/users/users.service");
    const { DriversService } = await import("../src/modules/drivers/drivers.service");
    const { UserRole } = await import("../src/common/types/user-role.enum");
    const { Vehicle, VehicleType } = await import("../src/modules/vehicles/schemas/vehicle.schema");
    const { DriverProfile, DriverStatus } = await import("../src/modules/drivers/schemas/driver-profile.schema");
    const { Ride } = await import("../src/modules/rides/schemas/ride.schema");
    const { DriverLocationCheckpoint } = await import(
      "../src/modules/locations/schemas/driver-location-checkpoint.schema"
    );

    rideModel = app.get(getModelToken(Ride.name), { strict: false });
    driverModel = app.get(getModelToken(DriverProfile.name), { strict: false });
    checkpointModel = app.get(getModelToken(DriverLocationCheckpoint.name), { strict: false });
    jwt = app.get(JwtService, { strict: false });
    const vehicleModel = app.get<Model<unknown>>(getModelToken(Vehicle.name), { strict: false });
    const users = app.get(UsersService, { strict: false });
    const drivers = app.get(DriversService, { strict: false });

    const admin = await users.create({ phone: PHONES.admin, password: PASSWORD, role: UserRole.ADMIN, firstName: "Ops" });
    userIds.admin = admin._id.toString();
    for (const key of ["customerA", "customerB"] as const) {
      const user = await users.create({ phone: PHONES[key], password: PASSWORD, role: UserRole.CUSTOMER, firstName: key });
      userIds[key] = user._id.toString();
    }
    for (const [key, plate] of [["autoNear", "UP85BB0001"], ["autoFar", "UP85BB0002"]] as const) {
      const user = await users.create({ phone: PHONES[key], password: PASSWORD, role: UserRole.DRIVER, firstName: key, lastName: "Driver" });
      userIds[key] = user._id.toString();
      const profile = await drivers.createProfileForUser(user._id.toString());
      await driverModel.updateOne({ _id: profile._id }, { $set: { driverStatus: DriverStatus.APPROVED } });
      await vehicleModel.create({ driverId: profile._id, vehicleType: VehicleType.AUTO, registrationNumber: plate, make: "Bajaj", vehicleModel: "RE", color: "Green", isActive: true });
      driverProfileIds[key] = profile._id.toString();
    }
    for (const key of Object.keys(PHONES) as Who[]) {
      const response = await api().post("/api/v1/auth/login").send({ phone: PHONES[key], password: PASSWORD }).expect(200);
      tokens[key] = response.body.data.accessToken as string;
    }
  }, 180_000);


  afterAll(async () => {
    for (const client of clients) client.close();
    await app?.close();
    await mongo?.stop();
    process.chdir(originalCwd);
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  // ── 3.1 Infrastructure & authentication ───────────────────────────────

  describe("Socket authentication", () => {
    it("rejects a handshake without a token", async () => {
      await expect(connect(undefined)).rejects.toMatchObject({ message: "AUTH_UNAUTHORIZED" });
    });

    it("rejects an invalid token", async () => {
      await expect(connect("not-a-jwt")).rejects.toMatchObject({ message: "AUTH_TOKEN_EXPIRED" });
    });

    it("rejects admin tokens (customer and driver apps only)", async () => {
      await expect(connectAs("admin")).rejects.toMatchObject({ message: "AUTH_FORBIDDEN" });
    });

    it("accepts customers and drivers and says who they are", async () => {
      const customer = await connectAs("customerA");
      const ready = (await customer.next("session.ready")) as unknown as { userId: string; role: string; rideIds: string[] };
      expect(ready).toMatchObject({ userId: userIds.customerA, role: "CUSTOMER", rideIds: [] });
      const driver = await connectAs("autoNear");
      expect(((await driver.next("session.ready")) as unknown as { role: string }).role).toBe("DRIVER");
      customer.close();
      driver.close();
    });

    it("tells the client and disconnects when the access token expires", async () => {
      const shortLived = jwt.sign(
        { sub: userIds.customerB, role: "CUSTOMER" },
        {
          secret: process.env.JWT_ACCESS_SECRET,
          expiresIn: "2s",
          issuer: "tirvona-ride-api",
          audience: "tirvona-ride-clients",
        },
      );
      const client = await connect(shortLived);
      const disconnected = new Promise((resolve) => client.socket.once("disconnect", resolve));
      await client.next("session.expired", undefined, 5_000);
      await disconnected;
    });
  });

  // ── 3.2–3.8 Full ride over the socket ─────────────────────────────────

  describe("A complete ride without polling", () => {
    let customer: Client;
    let intruder: Client;
    let near: Client;
    let far: Client;
    let rideId: string;
    let lastVersion = -1;

    const fresh = (payload: Envelope) => {
      expect(payload.stateVersion).toBeGreaterThan(lastVersion);
      lastVersion = payload.stateVersion!;
      return payload;
    };

    beforeAll(async () => {
      customer = await connectAs("customerA");
      intruder = await connectAs("customerB");
      near = await connectAs("autoNear");
      far = await connectAs("autoFar");
    });

    it("driver online: stored in MongoDB as online, available, fresh", async () => {
      await goOnline("autoNear", NEAR_PICKUP);
      await goOnline("autoFar", FAR_FROM_PICKUP);
      const dashboard = (await api().get("/api/v1/drivers/dashboard").set(as("autoNear")).expect(200)).body.data;
      expect(dashboard).toMatchObject({ isOnline: true, isAvailable: true, locationFresh: true });
    });

    it("booking pushes ride.requested / ride.driver_assigned to the customer and the offer to the nearest driver", async () => {
      const ride = await book("customerA");
      rideId = ride.id;

      expect(fresh(await customer.next("ride.requested", (e) => e.rideId === rideId)).status).toBe("SEARCHING");
      const assigned = fresh(await customer.next("ride.driver_assigned", (e) => e.rideId === rideId));
      expect(assigned.ride?.driver?.name).toContain("autoNear");

      const offer = await near.next("ride.requested", (e) => e.rideId === rideId);
      expect(offer.status).toBe("DRIVER_ASSIGNED");
      expect(offer.ride).toMatchObject({ id: rideId, customer: { name: "customerA" } });
      expect(offer.ride).not.toHaveProperty("otp");
      await far.none("ride.requested", (e) => e.rideId === rideId);
    });

    it("the offered driver cannot join the ride room before accepting; strangers never can", async () => {
      expect(await near.emit("ride.join", { rideId })).toMatchObject({ ok: false, code: "RIDE_NOT_ACTIVE" });
      expect(await intruder.emit("ride.join", { rideId })).toMatchObject({ ok: false, code: "RIDE_NOT_FOUND" });
      expect(await far.emit("ride.join", { rideId })).toMatchObject({ ok: false, code: "RIDE_NOT_FOUND" });
      expect(await intruder.emit("ride.join", { rideId: "not-an-id" })).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
      expect(await customer.emit("ride.join", { rideId })).toMatchObject({ ok: true, status: "DRIVER_ASSIGNED" });
    });

    it("accept → ride.driver_accepted reaches the customer immediately", async () => {
      await api().post(`/api/v1/rides/${rideId}/accept`).set(as("autoNear")).expect(200);
      const accepted = fresh(await customer.next("ride.driver_accepted", (e) => e.rideId === rideId));
      expect(accepted.data.driverId).toBe(driverProfileIds.autoNear);
      expect((await near.next("ride.driver_accepted")).rideId).toBe(rideId);
      // Now a member of the room.
      expect(await near.emit("ride.join", { rideId })).toMatchObject({ ok: true, status: "DRIVER_ACCEPTED" });
      expect((await driverModel.findById(driverProfileIds.autoNear).lean())).toMatchObject({ isOnline: true, isAvailable: false });
    });

    it("driver GPS is relayed to the customer only — not echoed, not to strangers", async () => {
      const ack = await near.emit("driver.location", { ...NEAR_PICKUP, heading: 90, speed: 6, accuracy: 5, rideId });
      expect(ack).toMatchObject({ ok: true, rideId, rideStatus: "DRIVER_ACCEPTED" });

      const update = await customer.next("ride.location_updated", (e) => e.rideId === rideId);
      expect(update.data).toMatchObject({
        driverId: driverProfileIds.autoNear,
        latitude: NEAR_PICKUP.latitude,
        longitude: NEAR_PICKUP.longitude,
        heading: 90,
      });
      expect(update).not.toHaveProperty("ride"); // lightweight
      await near.none("ride.location_updated");
      await intruder.none("ride.location_updated");
    });

    it("validates location input and the sender's role and ride", async () => {
      await sleep(250);
      expect(await near.emit("driver.location", { latitude: 123, longitude: 77 })).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
      expect(await near.emit("driver.location", { ...NEAR_PICKUP, extra: 1 })).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
      expect(await customer.emit("driver.location", NEAR_PICKUP)).toMatchObject({ ok: false, code: "AUTH_FORBIDDEN" });
      await sleep(250);
      expect(await near.emit("driver.location", { ...NEAR_PICKUP, rideId: "5f0000000000000000000000" })).toMatchObject({ ok: false, code: "RIDE_MISMATCH" });
      await sleep(250);
      expect(await near.emit("driver.location", { ...NEAR_PICKUP, accuracy: 900 })).toMatchObject({ ok: false, code: "LOW_ACCURACY" });
      expect(
        await near.emit("driver.location", { ...NEAR_PICKUP, recordedAt: new Date(Date.now() - 10 * 60_000).toISOString() }),
      ).toMatchObject({ ok: false, code: "STALE_FIX" });
    });

    it("rate limits a driver flooding fixes", async () => {
      await sleep(250);
      expect(await near.emit("driver.location", NEAR_PICKUP)).toMatchObject({ ok: true });
      expect(await near.emit("driver.location", NEAR_PICKUP)).toMatchObject({ ok: false, code: "RATE_LIMITED" });
    });

    it("does not write every GPS ping to MongoDB", async () => {
      const before = (await driverModel.findById(driverProfileIds.autoNear).lean())!.locationUpdatedAt!.getTime();
      for (let index = 0; index < 5; index += 1) {
        await sleep(220);
        // Jitter of a few metres around the same spot.
        const ack = await near.emit("driver.location", { latitude: NEAR_PICKUP.latitude + index * 1e-5, longitude: NEAR_PICKUP.longitude });
        expect(ack).toMatchObject({ ok: true, persisted: false });
      }
      const after = (await driverModel.findById(driverProfileIds.autoNear).lean())!.locationUpdatedAt!.getTime();
      expect(after).toBe(before);
    });

    it("emits ride.driver_arriving exactly once near the pickup", async () => {
      await sleep(250);
      await near.emit("driver.location", { ...AT_PICKUP, heading: 180 });
      const arriving = await customer.next("ride.driver_arriving", (e) => e.rideId === rideId);
      expect(arriving.data.distanceMeters).toBeLessThan(500);
      expect(arriving.data.etaSeconds).toBeGreaterThan(0);
      await sleep(250);
      await near.emit("driver.location", AT_PICKUP);
      await customer.none("ride.driver_arriving");
      expect((await rideModel.findById(rideId).lean())?.arrivingNotifiedAt).toBeInstanceOf(Date);
    });

    it("arrived → the customer (only) receives the OTP in the event", async () => {
      await api().post(`/api/v1/rides/${rideId}/arrived`).set(as("autoNear")).expect(200);
      const arrived = fresh(await customer.next("ride.driver_arrived"));
      expect(arrived.ride?.otp?.code).toMatch(/^\d{4}$/);
      const driverSide = await near.next("ride.driver_arrived");
      expect(driverSide.ride).not.toHaveProperty("otp");
    });

    it("rotating the OTP after too many wrong tries pushes the new code", async () => {
      const current = (await api().get(`/api/v1/rides/${rideId}`).set(as("customerA")).expect(200)).body.data.otp.code as string;
      const wrong = current === "0000" ? "1111" : "0000";
      for (let attempt = 0; attempt < 5; attempt += 1)
        await api().post(`/api/v1/rides/${rideId}/start`).set(as("autoNear")).send({ otp: wrong }).expect(400);
      const refreshed = fresh(await customer.next("ride.otp_refreshed"));
      expect(refreshed.ride?.otp?.code).toMatch(/^\d{4}$/);
      await near.none("ride.otp_refreshed");
    });

    it("start with the OTP → ride.started on both apps", async () => {
      const otp = (await api().get(`/api/v1/rides/${rideId}`).set(as("customerA")).expect(200)).body.data.otp.code as string;
      await api().post(`/api/v1/rides/${rideId}/start`).set(as("autoNear")).send({ otp }).expect(200);
      expect(fresh(await customer.next("ride.started")).status).toBe("RIDE_STARTED");
      expect((await near.next("ride.started")).status).toBe("RIDE_STARTED");
    });

    it("survives a customer reconnect mid-trip: rooms restored, live updates resume", async () => {
      customer.close();
      customer = await connectAs("customerA");
      const ready = (await customer.next("session.ready")) as unknown as { rideIds: string[] };
      expect(ready.rideIds).toEqual([rideId]);

      // REST is the recovery source of truth.
      const snapshot = (await api().get(`/api/v1/rides/${rideId}`).set(as("customerA")).expect(200)).body.data;
      expect(snapshot).toMatchObject({ status: "RIDE_STARTED", stateVersion: lastVersion });

      await sleep(250);
      expect(await near.emit("driver.location", { ...AT_DESTINATION, heading: 45 })).toMatchObject({ ok: true });
      expect((await customer.next("ride.location_updated")).data.latitude).toBe(BANKE_BIHARI.latitude);
    });

    it("complete → ride.completed on both apps, driver available, room closed", async () => {
      await api().post(`/api/v1/rides/${rideId}/complete`).set(as("autoNear")).expect(200);
      const completed = fresh(await customer.next("ride.completed"));
      expect(completed.ride).toMatchObject({ status: "COMPLETED" });
      await near.next("ride.completed");
      expect((await driverModel.findById(driverProfileIds.autoNear).lean())).toMatchObject({ isOnline: true, isAvailable: true });

      // Location after the ride is not relayed anywhere.
      await sleep(250);
      expect(await near.emit("driver.location", AT_DESTINATION)).toMatchObject({ ok: true, rideId: null });
      await customer.none("ride.location_updated");
      expect(await customer.emit("ride.join", { rideId })).toMatchObject({ ok: false, code: "RIDE_NOT_ACTIVE" });
    });

    it("keeps only coarse checkpoints for the ride", async () => {
      await sleep(300); // lifecycle checkpoints are written after the response
      const kinds = (await checkpointModel.find({ rideId }).lean()).map((row) => row.kind);
      expect(kinds).toEqual(expect.arrayContaining(["ACCEPTED", "ARRIVING", "ARRIVED", "STARTED", "COMPLETED"]));
      // ~12 fixes were streamed during the ride; the trail is a handful of rows.
      expect(kinds.length).toBeLessThanOrEqual(8);
    });

    afterAll(() => {
      for (const client of [customer, intruder, near, far]) client?.close();
    });
  });

  // ── Offers, timeouts, cancellation, availability ──────────────────────

  describe("Offers and cancellation", () => {
    it("an unanswered offer times out on its own and moves to the next driver", async () => {
      const customer = await connectAs("customerA");
      const near = await connectAs("autoNear");
      const far = await connectAs("autoFar");
      await goOnline("autoNear", NEAR_PICKUP);
      await goOnline("autoFar", FAR_FROM_PICKUP);

      const ride = await book("customerA");
      await near.next("ride.requested", (e) => e.rideId === ride.id);

      // No sweep is running: the per-ride deadline timer does this.
      const withdrawn = await near.next("ride.offer_withdrawn", (e) => e.rideId === ride.id, (ASSIGNMENT_TIMEOUT_SECONDS + 3) * 1000);
      expect(withdrawn.data.reason).toBe("ASSIGNMENT_TIMEOUT");
      expect(withdrawn).not.toHaveProperty("ride");
      await customer.next("ride.searching", (e) => e.rideId === ride.id);
      await far.next("ride.requested", (e) => e.rideId === ride.id);

      // Customer cancels → the offered driver's card goes away.
      await api().post(`/api/v1/rides/${ride.id}/cancel`).set(as("customerA")).send({ reason: "Changed plans" }).expect(200);
      expect((await far.next("ride.cancelled", (e) => e.rideId === ride.id)).status).toBe("CANCELLED");
      await customer.next("ride.cancelled", (e) => e.rideId === ride.id);
      for (const client of [customer, near, far]) client.close();
    }, 30_000);

    it("a driver with an active ride cannot go offline", async () => {
      const ride = await book("customerA");
      const offered = (await rideModel.findById(ride.id).lean())!;
      const who: Who = String((offered as unknown as { driverId: unknown }).driverId) === driverProfileIds.autoNear ? "autoNear" : "autoFar";
      await api().post(`/api/v1/rides/${ride.id}/accept`).set(as(who)).expect(200);
      const response = await api().patch("/api/v1/drivers/availability").set(as(who)).send({ isOnline: false }).expect(409);
      expect(response.body.code).toBe("DRIVER_HAS_ACTIVE_RIDE");
      await api().post(`/api/v1/rides/${ride.id}/cancel`).set(as("customerA")).send({ reason: "Test" }).expect(200);
    });

    it("drivers with a stale location are not matched and cannot go online without a new one", async () => {
      const stale = new Date(Date.now() - 10 * 60_000);
      await driverModel.updateMany({}, { $set: { locationUpdatedAt: stale } });
      const ride = await book("customerA");
      expect(ride.status).toBe("SEARCHING");
      await api().post(`/api/v1/rides/${ride.id}/cancel`).set(as("customerA")).send({ reason: "Test" }).expect(200);

      await api().patch("/api/v1/drivers/availability").set(as("autoNear")).send({ isOnline: false }).expect(200);
      const response = await api().patch("/api/v1/drivers/availability").set(as("autoNear")).send({ isOnline: true }).expect(400);
      expect(response.body.code).toBe("DRIVER_LOCATION_REQUIRED");
    });

    it("the REST fallback location path reports offline drivers", async () => {
      const response = await api().patch("/api/v1/drivers/location").set(as("autoNear")).send(NEAR_PICKUP).expect(409);
      expect(response.body.code).toBe("DRIVER_OFFLINE");
    });
  });
});
