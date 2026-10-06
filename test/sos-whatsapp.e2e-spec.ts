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
import {
  WhatsAppDeliveryError,
  WhatsAppGateway,
} from "../src/modules/whatsapp/whatsapp.gateway";
import type {
  AuthenticationCodeMessage,
  SosAlertMessage,
  WhatsAppFailureReason,
  WhatsAppSendResult,
} from "../src/modules/whatsapp/whatsapp.gateway";

/**
 * SOS → WhatsApp to the emergency contacts (docs/safety/sos-whatsapp.md): the
 * alert carries the location pin and a working live-tracking link, failures
 * are recorded and retried, updates are throttled, and the link ends with the
 * incident.
 */

class FakeWhatsApp extends WhatsAppGateway {
  readonly provider = "fake";
  readonly sos: SosAlertMessage[] = [];
  /** Per number: fail this many times (then succeed) or forever with a reason. */
  readonly failures = new Map<
    string,
    { times: number; reason: WhatsAppFailureReason }
  >();
  readonly attempts = new Map<string, number>();

  async sendAuthenticationCode(
    _message: AuthenticationCodeMessage,
  ): Promise<WhatsAppSendResult> {
    return { messageId: "wamid.otp" };
  }

  async sendSosAlert(message: SosAlertMessage): Promise<WhatsAppSendResult> {
    this.attempts.set(message.to, (this.attempts.get(message.to) ?? 0) + 1);
    const failure = this.failures.get(message.to);
    if (failure && failure.times > 0) {
      failure.times -= 1;
      throw new WhatsAppDeliveryError(failure.reason, "fake failure");
    }
    this.sos.push(message);
    return { messageId: `wamid.sos.${this.sos.length}` };
  }

  to(phone: string): SosAlertMessage[] {
    return this.sos.filter((message) => message.to === phone);
  }
}

const PASSWORD = "Password@123";
const PHONES = {
  admin: "+919870000001",
  customer: "+919870000002",
  driver: "+919870000003",
  stranger: "+919870000004",
} as const;
type Who = keyof typeof PHONES;
const CONTACT_A = "+919005011088";
const CONTACT_B = "+919811122233";
const CONTACT_C = "+919922233344";

describe("SOS → WhatsApp emergency contacts (e2e)", () => {
  const originalCwd = process.cwd();
  let workDir: string;
  let mongo: MongoMemoryServer;
  let app: INestApplication<App>;
  let db: Connection;
  let whatsapp: FakeWhatsApp;
  let drain: () => Promise<void>;
  const tokens = {} as Record<Who, string>;
  const userIds = {} as Record<Who, string>;
  let rideId: string;

  const api = () => request(app.getHttpServer());
  const as = (who: Who) => ({ Authorization: `Bearer ${tokens[who]}` });
  const press = (who: Who = "customer", body: Record<string, unknown> = {}) =>
    api().post(`/api/v1/rides/${rideId}/sos`).set(as(who)).send(body);
  const sosDoc = (id: string) =>
    db.collection("sos_events").findOne({ _id: new Types.ObjectId(id) });
  const addContact = (
    name: string,
    phone: string,
    extra: Record<string, unknown> = {},
  ) =>
    api()
      .post("/api/v1/users/me/emergency-contacts")
      .set(as("customer"))
      .send({ name, phone, ...extra })
      .expect(201);

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create({
      instance: { launchTimeout: 60_000 },
    });
    workDir = await mkdtemp(join(tmpdir(), "tirvona-ride-sos-wa-"));
    process.chdir(workDir);
    Object.assign(process.env, {
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      SWAGGER_ENABLED: "false",
      MONGODB_URI: mongo.getUri(),
      MONGODB_DB_NAME: "tirvona_ride_sos_whatsapp",
      REDIS_URL: "",
      THROTTLE_LIMIT: "5000",
      THROTTLE_AUTH_LIMIT: "1000",
      BROADCAST_WORKER_INTERVAL_MS: "0",
      PAYMENT_RECONCILE_INTERVAL_MS: "0",
      MATCHING_SWEEP_INTERVAL_MS: "0",
      JWT_ACCESS_SECRET: randomBytes(48).toString("base64url"),
      JWT_REFRESH_SECRET: randomBytes(48).toString("base64url"),
      WHATSAPP_PROVIDER: "log",
      SOS_CONTACT_RETRY_DELAY_MS: "5",
      SOS_CONTACT_UPDATE_MIN_SECONDS: "120",
      SOS_CONTACT_UPDATE_MAX: "2",
      SHARE_RIDE_LINK_BASE_URL: "https://track.tirvona.test/s",
    });

    const { AppModule } = await import("../src/app.module");
    const { configureApp } = await import("../src/app.setup");
    whatsapp = new FakeWhatsApp();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(WhatsAppGateway)
      .useValue(whatsapp)
      .compile();
    app = moduleRef.createNestApplication({ logger: false, rawBody: true });
    configureApp(app);
    await app.init();
    db = app.get<Connection>(getConnectionToken());

    const { UsersService } = await import("../src/modules/users/users.service");
    const { UserRole } = await import("../src/common/types/user-role.enum");
    const { SosContactAlertService } =
      await import("../src/modules/safety/sos-contact-alert.service");
    const users = app.get(UsersService, { strict: false });
    const alerts = app.get(SosContactAlertService, { strict: false });
    drain = () => alerts.drain();

    const roles = {
      admin: UserRole.ADMIN,
      customer: UserRole.CUSTOMER,
      driver: UserRole.DRIVER,
      stranger: UserRole.CUSTOMER,
    };
    for (const who of Object.keys(PHONES) as Who[]) {
      const user = await users.create({
        phone: PHONES[who],
        password: PASSWORD,
        role: roles[who],
        firstName: who === "customer" ? "Asha" : who,
        ...(who === "customer" ? { lastName: "Verma" } : {}),
      });
      userIds[who] = user._id.toString();
    }
    for (const who of Object.keys(PHONES) as Who[]) {
      const response = await api()
        .post("/api/v1/auth/login")
        .send({ phone: PHONES[who], password: PASSWORD })
        .expect(200);
      tokens[who] = response.body.data.accessToken as string;
    }

    // A ride in progress between the customer and the driver.
    const profile = await db.collection("driver_profiles").insertOne({
      userId: new Types.ObjectId(userIds.driver),
      driverCode: "DR-SOS-1",
      driverStatus: "APPROVED",
      isOnline: true,
      isAvailable: false,
      ratingAverage: 0,
      ratingCount: 0,
      totalRides: 0,
    });
    const ride = await db.collection("rides").insertOne({
      rideCode: "TRSOSWA001",
      customerId: new Types.ObjectId(userIds.customer),
      driverId: profile.insertedId,
      driverUserId: new Types.ObjectId(userIds.driver),
      rideType: "CAB",
      status: "RIDE_STARTED",
      isActive: true,
      pickup: {
        address: "Sector 62, Noida",
        latitude: 28.6208,
        longitude: 77.3639,
      },
      destination: {
        address: "Noida Electronic City",
        latitude: 28.6273,
        longitude: 77.3721,
      },
      vehicle: {
        vehicleType: "CAB",
        registrationNumber: "UP16AB1234",
        make: "Maruti",
        model: "Dzire",
        color: "White",
      },
      requestedAt: new Date(),
      startedAt: new Date(),
    });
    rideId = ride.insertedId.toHexString();
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
    process.chdir(originalCwd);
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  describe("without emergency contacts", () => {
    it("still raises the SOS and sends nothing", async () => {
      const result = (
        await press("customer", { latitude: 28.62, longitude: 77.365 }).expect(
          201,
        )
      ).body.data;
      expect(result.created).toBe(true);
      expect(result.sos.contacts).toEqual([]);
      await drain();
      expect(whatsapp.sos).toHaveLength(0);
      expect((await sosDoc(result.sos.id))?.contactsNotification).toBe(
        "NOT_SENT",
      );
      // Close it so the next incident starts clean.
      await api()
        .patch(`/api/v1/admin/sos/${result.sos.id}`)
        .set(as("admin"))
        .send({ status: "CANCELLED", note: "test" })
        .expect(200);
    });
  });

  describe("the first alert", () => {
    let sosId: string;

    it("messages every emergency contact with the location pin and a live link", async () => {
      await addContact("Kushal Pandey", CONTACT_A, {
        relationship: "Friend",
        isPrimary: true,
      });
      await addContact("Meera Verma", CONTACT_B, { relationship: "Sister" });

      const result = (
        await press("customer", {
          latitude: 28.6215,
          longitude: 77.3652,
          address: "Sushil Marg, Sector 62",
        }).expect(201)
      ).body.data;
      sosId = result.sos.id;
      // The press itself does not wait for WhatsApp.
      await drain();

      expect(whatsapp.to(CONTACT_A)).toHaveLength(1);
      expect(whatsapp.to(CONTACT_B)).toHaveLength(1);
      const message = whatsapp.to(CONTACT_A)[0];
      expect(message).toMatchObject({
        kind: "ALERT",
        personName: "Asha Verma",
        personPhone: PHONES.customer,
        rideCode: "TRSOSWA001",
        vehicle: "UP16AB1234 · White Maruti Dzire",
        reference: result.sos.sosCode,
        location: {
          latitude: 28.6215,
          longitude: 77.3652,
          name: "Asha's location",
          address: "Sushil Marg, Sector 62",
        },
      });
      expect(message.trackingUrl).toBe(
        `https://track.tirvona.test/s/${message.trackingToken}`,
      );
      // Both contacts get the same incident link.
      expect(whatsapp.to(CONTACT_B)[0].trackingToken).toBe(
        message.trackingToken,
      );
    });

    it("the link in the message is a working live view of the ride", async () => {
      const token = whatsapp.to(CONTACT_A)[0].trackingToken;
      const view = (
        await api().get(`/api/v1/shared-rides/${token}`).expect(200)
      ).body.data;
      expect(view).toMatchObject({ isLive: true, status: "RIDE_IN_PROGRESS" });
      expect(view.pickup.address).toBe("Sector 62, Noida");
    });

    it("is recorded on the incident and shown to the person who pressed it (without phone numbers)", async () => {
      const doc = await sosDoc(sosId);
      expect(doc?.contactsNotification).toBe("SENT");
      expect(doc?.contactAlerts).toHaveLength(2);
      expect(doc?.contactAlerts[0]).toMatchObject({
        kind: "ALERT",
        status: "SENT",
        attempts: 1,
      });

      const mine = (
        await api()
          .get(`/api/v1/rides/${rideId}/sos`)
          .set(as("customer"))
          .expect(200)
      ).body.data;
      expect(
        mine[0].contacts.map((c: { name: string; status: string }) => [
          c.name,
          c.status,
        ]),
      ).toEqual([
        ["Kushal Pandey", "SENT"],
        ["Meera Verma", "SENT"],
      ]);
      expect(JSON.stringify(mine)).not.toContain(CONTACT_A);
      expect(JSON.stringify(mine)).not.toContain("trackingToken");
    });

    it("never leaks the link or token through the admin API either, but shows who was reached", async () => {
      const detail = (
        await api()
          .get(`/api/v1/admin/sos/${sosId}`)
          .set(as("admin"))
          .expect(200)
      ).body.data;
      expect(detail.contactsNotification).toBe("SENT");
      expect(detail.trackingActive).toBe(true);
      expect(
        detail.contactAlerts.map((a: { name: string; status: string }) => [
          a.name,
          a.status,
        ]),
      ).toEqual([
        ["Kushal Pandey", "SENT"],
        ["Meera Verma", "SENT"],
      ]);
      expect(JSON.stringify(detail)).not.toContain(
        whatsapp.to(CONTACT_A)[0].trackingToken,
      );
    });

    it("pressing again soon does not message anyone twice", async () => {
      await press("customer", { latitude: 28.622, longitude: 77.366 }).expect(
        201,
      );
      await drain();
      expect(whatsapp.to(CONTACT_A)).toHaveLength(1);
      expect(whatsapp.to(CONTACT_B)).toHaveLength(1);
    });
  });

  describe("location updates", () => {
    it("are sent as updates with the newest position, rate limited and capped", async () => {
      const sosId = (
        await api()
          .get(`/api/v1/rides/${rideId}/sos`)
          .set(as("customer"))
          .expect(200)
      ).body.data[0].id as string;
      const setAge = (minutes: number) =>
        db
          .collection("sos_events")
          .updateOne(
            { _id: new Types.ObjectId(sosId) },
            {
              $set: {
                "contactAlerts.$[].at": new Date(Date.now() - minutes * 60_000),
              },
            },
          );

      await setAge(10);
      await press("customer", { latitude: 28.6231, longitude: 77.3671 }).expect(
        201,
      );
      await drain();
      const updates = whatsapp
        .to(CONTACT_A)
        .filter((message) => message.kind === "UPDATE");
      expect(updates).toHaveLength(1);
      expect(updates[0].location).toMatchObject({
        latitude: 28.6231,
        longitude: 77.3671,
      });
      expect(updates[0].trackingToken).toBe(
        whatsapp.to(CONTACT_A)[0].trackingToken,
      );

      // Cap of 2 updates per contact (SOS_CONTACT_UPDATE_MAX).
      await setAge(10);
      await press("customer", { latitude: 28.6241, longitude: 77.3681 }).expect(
        201,
      );
      await drain();
      await setAge(10);
      await press("customer", { latitude: 28.6251, longitude: 77.3691 }).expect(
        201,
      );
      await drain();
      expect(
        whatsapp.to(CONTACT_A).filter((message) => message.kind === "UPDATE"),
      ).toHaveLength(2);
    });
  });

  describe("when WhatsApp fails", () => {
    let sosId: string;

    beforeAll(async () => {
      // A fresh incident with two different problems: one contact is flaky, one is not on WhatsApp.
      const open = (
        await api()
          .get(`/api/v1/rides/${rideId}/sos`)
          .set(as("customer"))
          .expect(200)
      ).body.data[0];
      await api()
        .patch(`/api/v1/admin/sos/${open.id}`)
        .set(as("admin"))
        .send({ status: "RESOLVED", note: "done" })
        .expect(200);
      await addContact("Rohit", CONTACT_C);
      whatsapp.failures.set(CONTACT_B, { times: 2, reason: "UNAVAILABLE" });
      whatsapp.failures.set(CONTACT_C, {
        times: 99,
        reason: "RECIPIENT_UNAVAILABLE",
      });
      whatsapp.sos.length = 0;
      whatsapp.attempts.clear();
    });

    it("retries a transient failure, gives up at once on a number that is not on WhatsApp, and still raises the SOS", async () => {
      const result = (
        await press("customer", { latitude: 28.63, longitude: 77.37 }).expect(
          201,
        )
      ).body.data;
      sosId = result.sos.id;
      await drain();

      expect(whatsapp.to(CONTACT_A)).toHaveLength(1);
      expect(whatsapp.attempts.get(CONTACT_B)).toBe(3);
      expect(whatsapp.to(CONTACT_B)).toHaveLength(1);
      expect(whatsapp.attempts.get(CONTACT_C)).toBe(1);

      const doc = await sosDoc(sosId);
      expect(doc?.contactsNotification).toBe("SENT");
      const byPhone = Object.fromEntries(
        ((doc?.contactAlerts ?? []) as Array<{ phone: string }>).map(
          (entry) => [entry.phone, entry],
        ),
      );
      expect(byPhone[CONTACT_B]).toMatchObject({ status: "SENT", attempts: 3 });
      expect(byPhone[CONTACT_C]).toMatchObject({
        status: "FAILED",
        failure: expect.stringContaining("not on WhatsApp"),
      });

      const mine = (
        await api()
          .get(`/api/v1/rides/${rideId}/sos`)
          .set(as("customer"))
          .expect(200)
      ).body.data;
      expect(
        mine[0].contacts.map((c: { name: string; status: string }) => c.status),
      ).toEqual(["SENT", "SENT", "FAILED"]);
    });

    it("the safety team can try the failed contact again", async () => {
      whatsapp.failures.delete(CONTACT_C);
      const detail = (
        await api()
          .post(`/api/v1/admin/sos/${sosId}/notify-contacts`)
          .set(as("admin"))
          .expect(200)
      ).body.data;
      expect(
        whatsapp.to(CONTACT_C).filter((message) => message.kind === "ALERT"),
      ).toHaveLength(1);
      expect(
        detail.contactAlerts
          .filter((a: { name: string; status: string }) => a.name === "Rohit")
          .map((a: { status: string }) => a.status),
      ).toEqual(["FAILED", "SENT"]);
      // Nobody who already has the alert is messaged again by a resend.
      expect(
        whatsapp.to(CONTACT_A).filter((message) => message.kind === "ALERT"),
      ).toHaveLength(1);
    });

    it("is FAILED on the incident when no contact could be reached", async () => {
      const open = (
        await api()
          .get(`/api/v1/rides/${rideId}/sos`)
          .set(as("customer"))
          .expect(200)
      ).body.data[0];
      await api()
        .patch(`/api/v1/admin/sos/${open.id}`)
        .set(as("admin"))
        .send({ status: "RESOLVED", note: "done" })
        .expect(200);
      for (const phone of [CONTACT_A, CONTACT_B, CONTACT_C])
        whatsapp.failures.set(phone, { times: 99, reason: "MISCONFIGURED" });
      const result = (
        await press("customer", { latitude: 28.64, longitude: 77.38 }).expect(
          201,
        )
      ).body.data;
      await drain();
      expect(result.created).toBe(true);
      expect((await sosDoc(result.sos.id))?.contactsNotification).toBe(
        "FAILED",
      );
      // A broken setup is not retried within the request.
      expect(whatsapp.attempts.get(CONTACT_A)).toBeGreaterThanOrEqual(1);
      for (const phone of [CONTACT_A, CONTACT_B, CONTACT_C])
        whatsapp.failures.delete(phone);
    });
  });

  describe("the live link", () => {
    it("is not ended by the rider stopping their own sharing", async () => {
      const open = (
        await api()
          .get(`/api/v1/rides/${rideId}/sos`)
          .set(as("customer"))
          .expect(200)
      ).body.data[0];
      const doc = await sosDoc(open.id);
      const token = (
        await db
          .collection("sos_events")
          .findOne(
            { _id: new Types.ObjectId(open.id) },
            { projection: { trackingToken: 1 } },
          )
      )?.trackingToken as string;
      expect(doc?.isOpen).toBe(true);
      expect(token).toBeTruthy();

      // The rider makes a link and then stops sharing: the incident's link must survive.
      await api()
        .post(`/api/v1/rides/${rideId}/share`)
        .set(as("customer"))
        .expect(201);
      await api()
        .delete(`/api/v1/rides/${rideId}/share`)
        .set(as("customer"))
        .expect(200);
      await api().get(`/api/v1/shared-rides/${token}`).expect(200);
    });

    it("stops working when the safety team resolves the incident", async () => {
      const open = (
        await api()
          .get(`/api/v1/rides/${rideId}/sos`)
          .set(as("customer"))
          .expect(200)
      ).body.data[0];
      const token = (
        await db
          .collection("sos_events")
          .findOne(
            { _id: new Types.ObjectId(open.id) },
            { projection: { trackingToken: 1 } },
          )
      )?.trackingToken as string;
      await api()
        .patch(`/api/v1/admin/sos/${open.id}`)
        .set(as("admin"))
        .send({ status: "RESOLVED", note: "Rider safe" })
        .expect(200);
      await api().get(`/api/v1/shared-rides/${token}`).expect(404);
      const detail = (
        await api()
          .get(`/api/v1/admin/sos/${open.id}`)
          .set(as("admin"))
          .expect(200)
      ).body.data;
      expect(detail.trackingActive).toBe(false);
    });
  });

  describe("access", () => {
    it("only the safety team can resend, and a closed incident cannot be", async () => {
      const closed = (
        await api()
          .get(`/api/v1/rides/${rideId}/sos`)
          .set(as("customer"))
          .expect(200)
      ).body.data[0];
      await api()
        .post(`/api/v1/admin/sos/${closed.id}/notify-contacts`)
        .set(as("customer"))
        .expect(403);
      await api()
        .post(`/api/v1/admin/sos/${closed.id}/notify-contacts`)
        .set(as("admin"))
        .expect(409);
      await api()
        .post(`/api/v1/admin/sos/${closed.id}/notify-contacts`)
        .expect(401);
    });

    it("a stranger cannot trigger or read SOS on someone else's ride", async () => {
      await press("stranger").expect(404);
    });
  });
});
