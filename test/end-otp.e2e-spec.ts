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

/**
 * End-of-trip OTP: the driver asks to end the trip, the rider's app shows a
 * code, the driver types it to complete. Covers the code lifecycle (attempts,
 * rotation, expiry), the fare frozen at the request, the far-from-drop-off
 * flag, "rider not responding", the SOS bypass, the admin completion and who
 * can see what. Hermetic: in-memory MongoDB, no Redis.
 */

const PASSWORD = "Password@123";
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
const NEAR_PICKUP = { latitude: 27.5725, longitude: 77.677 };
const AT_DESTINATION = {
  latitude: BANKE_BIHARI.latitude,
  longitude: BANKE_BIHARI.longitude,
};
const PHONES = {
  admin: "+919830000000",
  customer: "+919830000001",
  other: "+919830000002",
  driver: "+919830000011",
};
type Who = keyof typeof PHONES;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Envelope {
  event: string;
  rideId: string;
  status?: string;
  ride?: { otp?: { code: string; purpose: string } };
}

describe("End-of-trip OTP (e2e)", () => {
  const originalCwd = process.cwd();
  let workDir: string;
  let mongo: MongoMemoryServer;
  let app: INestApplication<App>;
  let baseUrl: string;
  const tokens = {} as Record<Who, string>;
  const received: Array<{ event: string; payload: Envelope }> = [];
  let customerSocket: Socket;
  let rideModel: Model<Record<string, unknown>>;
  let notificationModel: Model<Record<string, unknown>>;
  let driverLocation: { latitude: number; longitude: number };

  const api = () => request(app.getHttpServer());
  const as = (who: Who) => ({ Authorization: `Bearer ${tokens[who]}` });

  async function placeDriver(at: { latitude: number; longitude: number }) {
    driverLocation = at;
    await api()
      .patch("/api/v1/drivers/availability")
      .set(as("driver"))
      .send({ isOnline: true, ...at })
      .expect(200);
  }

  /** Books, accepts, arrives and starts a ride; returns its id with the driver at `at`. */
  async function startedRide(
    at: { latitude: number; longitude: number } = NEAR_PICKUP,
  ): Promise<string> {
    await placeDriver(at);
    const booked = await api()
      .post("/api/v1/rides")
      .set(as("customer"))
      .send({
        rideType: "AUTO",
        pickup: PREM_MANDIR,
        destination: BANKE_BIHARI,
      })
      .expect(201);
    const id = booked.body.data.id as string;
    await api().post(`/api/v1/rides/${id}/accept`).set(as("driver")).expect(200);
    await api()
      .post(`/api/v1/rides/${id}/arrived`)
      .set(as("driver"))
      .expect(200);
    const otp = (
      await api().get(`/api/v1/rides/${id}`).set(as("customer")).expect(200)
    ).body.data.otp.code as string;
    await api()
      .post(`/api/v1/rides/${id}/start`)
      .set(as("driver"))
      .send({ otp })
      .expect(200);
    return id;
  }

  const riderView = async (id: string) =>
    (await api().get(`/api/v1/rides/${id}`).set(as("customer")).expect(200))
      .body.data;
  const requestEnd = async (id: string) =>
    (
      await api()
        .post(`/api/v1/rides/${id}/request-end`)
        .set(as("driver"))
        .expect(200)
    ).body.data;
  const adminDetail = async (id: string) =>
    (await api().get(`/api/v1/admin/rides/${id}`).set(as("admin")).expect(200))
      .body.data;
  const completeWith = (id: string, otp?: string) =>
    api()
      .post(`/api/v1/rides/${id}/complete`)
      .set(as("driver"))
      .send(otp === undefined ? {} : { otp });
  const wrongCode = (code: string) => (code === "0000" ? "1111" : "0000");

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create({
      instance: { launchTimeout: 60_000 },
    });
    workDir = await mkdtemp(join(tmpdir(), "tirvona-ride-end-otp-"));
    process.chdir(workDir);
    Object.assign(process.env, {
      NODE_ENV: "test",
      // The final fare must follow the trip's real duration to prove it stops at the request.
      FINAL_FARE_MODE: "actual",
      RIDE_END_OTP_ENFORCED: "true",
      RIDE_END_OVERRIDE_WAIT_SECONDS: "120",
      RIDE_END_FAR_RADIUS_METERS: "500",
      LOG_LEVEL: "silent",
      SWAGGER_ENABLED: "false",
      MONGODB_URI: mongo.getUri(),
      MONGODB_DB_NAME: "tirvona_ride_end_otp",
      REDIS_URL: "",
      THROTTLE_LIMIT: "5000",
      THROTTLE_AUTH_LIMIT: "1000",
      THROTTLE_ADMIN_LOGIN_LIMIT: "1000",
      JWT_ACCESS_SECRET: randomBytes(48).toString("base64url"),
      JWT_REFRESH_SECRET: randomBytes(48).toString("base64url"),
      MATCHING_SWEEP_INTERVAL_MS: "0",
      MATCHING_REACTIVE_DISPATCH: "true",
      PAYMENT_RECONCILE_INTERVAL_MS: "0",
      BROADCAST_WORKER_INTERVAL_MS: "0",
      PLACES_PROVIDER: "none",
      DRIVER_LOCATION_MIN_INTERVAL_MS: "200",
    });

    const { AppModule } = await import("../src/app.module");
    const { configureApp } = await import("../src/app.setup");
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false, rawBody: true });
    configureApp(app);
    await app.listen(0, "127.0.0.1");
    baseUrl = `http://127.0.0.1:${((app.getHttpServer() as unknown as Server).address() as AddressInfo).port}`;

    const { UsersService } = await import("../src/modules/users/users.service");
    const { DriversService } =
      await import("../src/modules/drivers/drivers.service");
    const { UserRole } = await import("../src/common/types/user-role.enum");
    const { Vehicle, VehicleType } =
      await import("../src/modules/vehicles/schemas/vehicle.schema");
    const { DriverProfile, DriverStatus } =
      await import("../src/modules/drivers/schemas/driver-profile.schema");
    const { Ride } = await import("../src/modules/rides/schemas/ride.schema");
    const { Notification } =
      await import("../src/modules/notifications/schemas/notification.schema");

    rideModel = app.get(getModelToken(Ride.name), { strict: false });
    notificationModel = app.get(getModelToken(Notification.name), {
      strict: false,
    });
    const driverModel = app.get<Model<unknown>>(
      getModelToken(DriverProfile.name),
      { strict: false },
    );
    const vehicleModel = app.get<Model<unknown>>(getModelToken(Vehicle.name), {
      strict: false,
    });
    const users = app.get(UsersService, { strict: false });
    const drivers = app.get(DriversService, { strict: false });

    await users.create({
      phone: PHONES.admin,
      password: PASSWORD,
      role: UserRole.ADMIN,
      firstName: "Ops",
    });
    for (const who of ["customer", "other"] as const)
      await users.create({
        phone: PHONES[who],
        password: PASSWORD,
        role: UserRole.CUSTOMER,
        firstName: who,
      });
    const driverUser = await users.create({
      phone: PHONES.driver,
      password: PASSWORD,
      role: UserRole.DRIVER,
      firstName: "Raju",
      lastName: "Driver",
    });
    const profile = await drivers.createProfileForUser(
      driverUser._id.toString(),
    );
    await driverModel.updateOne(
      { _id: profile._id },
      { $set: { driverStatus: DriverStatus.APPROVED } },
    );
    await vehicleModel.create({
      driverId: profile._id,
      vehicleType: VehicleType.AUTO,
      registrationNumber: "UP85EE0001",
      make: "Bajaj",
      vehicleModel: "RE",
      color: "Green",
      isActive: true,
    });
    for (const who of Object.keys(PHONES) as Who[]) {
      const response = await api()
        .post("/api/v1/auth/login")
        .send({ phone: PHONES[who], password: PASSWORD })
        .expect(200);
      tokens[who] = response.body.data.accessToken as string;
    }

    customerSocket = io(`${baseUrl}/realtime`, {
      transports: ["websocket"],
      auth: { token: tokens.customer },
      reconnection: false,
      forceNew: true,
    });
    customerSocket.onAny((event: string, payload: Envelope) =>
      received.push({ event, payload }),
    );
    await new Promise<void>((resolve, reject) => {
      customerSocket.once("connect", () => resolve());
      customerSocket.once("connect_error", reject);
    });
  }, 180_000);

  afterAll(async () => {
    customerSocket?.disconnect();
    await app?.close();
    await mongo?.stop();
    process.chdir(originalCwd);
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  async function nextEvent(
    event: string,
    rideId: string,
    timeoutMs = 6_000,
  ): Promise<Envelope> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const index = received.findIndex(
        (entry) => entry.event === event && entry.payload.rideId === rideId,
      );
      if (index >= 0) return received.splice(index, 1)[0].payload;
      await sleep(20);
    }
    throw new Error(`Timed out waiting for ${event}`);
  }

  describe("asking to end the trip", () => {
    let rideId: string;

    beforeAll(async () => {
      rideId = await startedRide();
    });

    it("refuses to complete before the end code was requested", async () => {
      const response = await completeWith(rideId).expect(409);
      expect(response.body.code).toBe("RIDE_END_OTP_REQUIRED");
      expect(response.body.data).toMatchObject({
        currentStatus: "RIDE_STARTED",
        endRequested: false,
      });
      // The rider has no code to give yet.
      expect((await riderView(rideId)).otp).toBeUndefined();
    });

    it("only a driver of the ride can ask to end it", async () => {
      await api()
        .post(`/api/v1/rides/${rideId}/request-end`)
        .set(as("customer"))
        .expect(403);
      await api()
        .post(`/api/v1/rides/${rideId}/request-end`)
        .set(as("other"))
        .expect(403);
    });

    it("shows the rider an END code, pushes it in realtime and as a notification, and gives the driver a timer", async () => {
      received.length = 0;
      const driverView = await requestEnd(rideId);

      expect(driverView.status).toBe("RIDE_STARTED");
      expect(driverView.endRequestedAt).toBeDefined();
      expect(driverView.endOtp).toMatchObject({
        requestedAt: driverView.endRequestedAt,
      });
      expect(
        Date.parse(driverView.endOtp.overrideAvailableAt) -
          Date.parse(driverView.endOtp.requestedAt),
      ).toBe(120_000);
      // The driver never receives the code.
      expect(JSON.stringify(driverView)).not.toMatch(/"code"/);

      const rider = await riderView(rideId);
      expect(rider.otp).toMatchObject({ purpose: "END" });
      expect(rider.otp.code).toMatch(/^\d{4}$/);

      const event = await nextEvent("ride.end_requested", rideId);
      expect(event.ride?.otp).toMatchObject({
        code: rider.otp.code,
        purpose: "END",
      });

      await sleep(300);
      const notice = await notificationModel
        .findOne({ type: "RIDE_END_OTP" })
        .lean();
      expect(notice).toMatchObject({ title: "Share your end-of-trip OTP" });
      // The notification never carries the code.
      expect(JSON.stringify(notice)).not.toContain(rider.otp.code);
    });

    it("asking again returns the same request and the same code", async () => {
      const before = await riderView(rideId);
      const again = await requestEnd(rideId);
      expect(again.endRequestedAt).toBeDefined();
      expect((await riderView(rideId)).otp.code).toBe(before.otp.code);
    });

    it("flags a trip ended far from the booked drop-off, without exposing it to the apps", async () => {
      const detail = await adminDetail(rideId);
      expect(detail.ride.end).toMatchObject({
        farFromDestination: true,
        needsReview: true,
      });
      expect(detail.ride.end.distanceToDestinationMeters).toBeGreaterThan(500);
      // Never the code itself.
      expect(JSON.stringify(detail)).not.toContain(
        (await riderView(rideId)).otp.code,
      );
      expect(JSON.stringify(await riderView(rideId))).not.toContain(
        "farFromDestination",
      );
    });

    it("counts wrong codes, then rotates the code and pushes the new one", async () => {
      received.length = 0;
      const code = (await riderView(rideId)).otp.code as string;
      const first = await completeWith(rideId, wrongCode(code)).expect(400);
      expect(first.body.code).toBe("RIDE_OTP_INVALID");
      expect(first.body.data.attemptsRemaining).toBe(4);
      for (let attempt = 0; attempt < 3; attempt += 1)
        await completeWith(rideId, wrongCode(code)).expect(400);
      const locked = await completeWith(rideId, wrongCode(code)).expect(400);
      expect(locked.body.code).toBe("RIDE_OTP_TOO_MANY_ATTEMPTS");

      const refreshed = await nextEvent("ride.otp_refreshed", rideId);
      expect(refreshed.ride?.otp?.purpose).toBe("END");
      // The old code is useless now.
      expect(await riderView(rideId)).toMatchObject({
        otp: { code: refreshed.ride?.otp?.code },
      });
      expect(refreshed.ride?.otp?.code).not.toBe(code);
    });

    it("an expired code is rotated, not accepted", async () => {
      const code = (await riderView(rideId)).otp.code as string;
      await rideModel.updateOne(
        { _id: rideId },
        { $set: { endOtpExpiresAt: new Date(Date.now() - 1_000) } },
      );
      const response = await completeWith(rideId, code).expect(400);
      expect(response.body.code).toBe("RIDE_OTP_EXPIRED");
      const fresh = (await riderView(rideId)).otp;
      expect(fresh.code).not.toBe(code);
      expect(Date.parse(fresh.expiresAt)).toBeGreaterThan(Date.now());
    });

    it("the rider's code completes it; the fare stops when the driver asked, not when the code was typed", async () => {
      // 20 minutes of trip, the end was requested 5 minutes ago.
      const now = Date.now();
      await rideModel.updateOne(
        { _id: rideId },
        {
          $set: {
            startedAt: new Date(now - 20 * 60_000),
            endRequestedAt: new Date(now - 5 * 60_000),
          },
        },
      );
      const code = (await riderView(rideId)).otp.code as string;
      const response = await completeWith(rideId, code).expect(200);

      expect(response.body.data.status).toBe("COMPLETED");
      expect(response.body.data.completionMode).toBe("OTP");
      const durationSeconds = response.body.data.fare.final
        .durationSeconds as number;
      expect(Math.abs(durationSeconds - 15 * 60)).toBeLessThanOrEqual(2);
      expect(response.body.data.completedAt).toBe(
        response.body.data.endRequestedAt,
      );

      // One use only; the code is gone from the rider's view.
      await completeWith(rideId, code).expect(409);
      expect((await riderView(rideId)).otp).toBeUndefined();
      const detail = await adminDetail(rideId);
      expect(detail.ride.end).toMatchObject({
        mode: "OTP",
        otpVerifiedAt: expect.any(String),
      });
      const raw = await rideModel
        .findById(rideId)
        .select("+endOtpCode")
        .lean();
      expect(raw).not.toHaveProperty("endOtpCode");
    });
  });

  describe("taking the end request back", () => {
    it("removes the rider's code, and a new request freezes the fare to the new moment", async () => {
      const rideId = await startedRide(AT_DESTINATION);
      const first = await requestEnd(rideId);
      expect((await riderView(rideId)).otp.purpose).toBe("END");
      // Near the drop-off: not flagged.
      expect((await adminDetail(rideId)).ride.end.farFromDestination).toBe(
        false,
      );

      received.length = 0;
      const cancelled = (
        await api()
          .post(`/api/v1/rides/${rideId}/cancel-end`)
          .set(as("driver"))
          .expect(200)
      ).body.data;
      expect(cancelled.endRequestedAt).toBeUndefined();
      expect(cancelled.endOtp).toBeUndefined();
      expect((await riderView(rideId)).otp).toBeUndefined();
      await nextEvent("ride.end_cancelled", rideId);
      // Nothing to give any more.
      await completeWith(rideId).expect(409);

      await sleep(20);
      const second = await requestEnd(rideId);
      expect(Date.parse(second.endRequestedAt)).toBeGreaterThan(
        Date.parse(first.endRequestedAt),
      );

      // Finish it so the next scenario can book.
      await completeWith(rideId, (await riderView(rideId)).otp.code).expect(
        200,
      );
    });
  });

  describe("rider not responding", () => {
    it("is refused until the driver asked and waited, then completes and is flagged for review", async () => {
      const rideId = await startedRide(AT_DESTINATION);
      const reason = { reason: "Rider left the vehicle and is not answering" };

      const early = await api()
        .post(`/api/v1/rides/${rideId}/complete-without-otp`)
        .set(as("driver"))
        .send(reason)
        .expect(409);
      expect(early.body.code).toBe("RIDE_END_NOT_REQUESTED");

      await requestEnd(rideId);
      const tooSoon = await api()
        .post(`/api/v1/rides/${rideId}/complete-without-otp`)
        .set(as("driver"))
        .send(reason)
        .expect(409);
      expect(tooSoon.body.code).toBe("RIDE_END_OVERRIDE_TOO_EARLY");
      expect(tooSoon.body.data.retryAfterSeconds).toBeGreaterThan(0);

      await api()
        .post(`/api/v1/rides/${rideId}/complete-without-otp`)
        .set(as("driver"))
        .send({ reason: "no" })
        .expect(400);

      await rideModel.updateOne(
        { _id: rideId },
        { $set: { endRequestedAt: new Date(Date.now() - 3 * 60_000) } },
      );
      const done = await api()
        .post(`/api/v1/rides/${rideId}/complete-without-otp`)
        .set(as("driver"))
        .send(reason)
        .expect(200);
      expect(done.body.data).toMatchObject({
        status: "COMPLETED",
        completionMode: "DRIVER_OVERRIDE",
      });

      const detail = await adminDetail(rideId);
      expect(detail.ride.end).toMatchObject({
        mode: "DRIVER_OVERRIDE",
        note: reason.reason,
        needsReview: true,
      });
      const flagged = (
        await api()
          .get("/api/v1/admin/rides")
          .query({ needsReview: "true" })
          .set(as("admin"))
          .expect(200)
      ).body.data.items as Array<{ id: string; end: { needsReview: boolean } }>;
      expect(flagged.map((ride) => ride.id)).toContain(rideId);
      expect(flagged.every((ride) => ride.end.needsReview)).toBe(true);
    });
  });

  describe("an open SOS", () => {
    it("needs no code to end the trip, and no wait to end it without one", async () => {
      const rideId = await startedRide(AT_DESTINATION);
      await api()
        .post(`/api/v1/rides/${rideId}/sos`)
        .set(as("customer"))
        .send({ ...driverLocation })
        .expect(201);

      const done = await completeWith(rideId).expect(200);
      expect(done.body.data).toMatchObject({
        status: "COMPLETED",
        completionMode: "SOS",
      });
      expect((await adminDetail(rideId)).ride.end.needsReview).toBe(true);
    });

    it("lets the driver end without a code immediately after asking", async () => {
      const rideId = await startedRide(AT_DESTINATION);
      await requestEnd(rideId);
      await api()
        .post(`/api/v1/rides/${rideId}/sos`)
        .set(as("driver"))
        .send({ ...driverLocation })
        .expect(201);
      const done = await api()
        .post(`/api/v1/rides/${rideId}/complete-without-otp`)
        .set(as("driver"))
        .send({ reason: "Emergency, ending the trip" })
        .expect(200);
      expect(done.body.data.completionMode).toBe("SOS");
    });
  });

  describe("ops completing a trip", () => {
    it("completes with a note, records ADMIN, and is audited", async () => {
      const rideId = await startedRide(AT_DESTINATION);
      await api()
        .post(`/api/v1/admin/rides/${rideId}/complete`)
        .set(as("admin"))
        .send({})
        .expect(400);
      await api()
        .post(`/api/v1/admin/rides/${rideId}/complete`)
        .set(as("customer"))
        .send({ note: "trying" })
        .expect(403);

      const response = await api()
        .post(`/api/v1/admin/rides/${rideId}/complete`)
        .set(as("admin"))
        .send({ note: "Rider unreachable; driver confirmed the drop-off" })
        .expect(200);
      expect(response.body.data.ride.status).toBe("COMPLETED");
      expect(response.body.data.ride.end).toMatchObject({
        mode: "ADMIN",
        note: "Rider unreachable; driver confirmed the drop-off",
        needsReview: true,
      });
      expect(
        response.body.data.history.at(-1),
      ).toMatchObject({ toStatus: "COMPLETED", actorType: "ADMIN" });

      // Already completed: a conflict, not a second completion.
      await api()
        .post(`/api/v1/admin/rides/${rideId}/complete`)
        .set(as("admin"))
        .send({ note: "again" })
        .expect(409);
    });
  });
});
