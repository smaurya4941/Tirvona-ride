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
import type {
  PushMessage,
  PushResult,
} from "../src/modules/notifications/push/push.gateway";

/**
 * GET /rides — the app's "Your rides" list: pages plus a requestedAt window
 * (startDate inclusive, endDate exclusive, instants with an offset).
 */

const PASSWORD = "Password@123";
const PHONES = { customer: "+919860000001", other: "+919860000002" };
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
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

class FakePush extends PushGateway {
  readonly isConfigured = false;
  async send(tokens: string[], _message: PushMessage): Promise<PushResult[]> {
    return tokens.map((token) => ({
      token,
      delivered: false,
      tokenInvalid: false,
    }));
  }
}

interface HistoryPage {
  items: Array<{ id: string; rideCode: string; requestedAt: string }>;
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
}

describe("Ride history filter & pagination (e2e)", () => {
  const originalCwd = process.cwd();
  let workDir: string;
  let mongo: MongoMemoryServer;
  let app: INestApplication<App>;
  let db: Connection;
  const tokens: Record<string, string> = {};
  const now = Date.now();
  /** rideCode → requestedAt for the customer's rides. */
  const seeded = new Map<string, Date>();

  const api = () => request(app.getHttpServer());
  const as = (who: keyof typeof PHONES) => ({
    Authorization: `Bearer ${tokens[who]}`,
  });
  const history = async (
    who: keyof typeof PHONES,
    query: Record<string, string | number>,
  ) =>
    (await api().get("/api/v1/rides").query(query).set(as(who)).expect(200))
      .body.data as HistoryPage;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create({
      instance: { launchTimeout: 60_000 },
    });
    workDir = await mkdtemp(join(tmpdir(), "tirvona-ride-history-"));
    process.chdir(workDir);
    Object.assign(process.env, {
      NODE_ENV: "test",
      FINAL_FARE_MODE: "booked",
      LOG_LEVEL: "silent",
      SWAGGER_ENABLED: "false",
      MONGODB_URI: mongo.getUri(),
      MONGODB_DB_NAME: "tirvona_ride_history",
      REDIS_URL: "",
      THROTTLE_LIMIT: "5000",
      THROTTLE_AUTH_LIMIT: "1000",
      THROTTLE_ADMIN_LOGIN_LIMIT: "1000",
      JWT_ACCESS_SECRET: randomBytes(48).toString("base64url"),
      JWT_REFRESH_SECRET: randomBytes(48).toString("base64url"),
      MATCHING_SWEEP_INTERVAL_MS: "0",
      MATCHING_REACTIVE_DISPATCH: "false",
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
    for (const who of Object.keys(PHONES) as Array<keyof typeof PHONES>) {
      await users.create({
        phone: PHONES[who],
        password: PASSWORD,
        role: UserRole.CUSTOMER,
        firstName: who,
      });
      const response = await api()
        .post("/api/v1/auth/login")
        .send({ phone: PHONES[who], password: PASSWORD })
        .expect(200);
      tokens[who] = response.body.data.accessToken as string;
    }

    // One real booking gives a complete ride document; the rest of the
    // history is copies of it at known times.
    const booked = await api()
      .post("/api/v1/rides")
      .set(as("customer"))
      .send({
        rideType: "AUTO",
        pickup: PREM_MANDIR,
        destination: BANKE_BIHARI,
      })
      .expect(201);
    const rides = db.collection("rides");
    const template = await rides.findOne({
      _id: new Types.ObjectId(booked.body.data.id as string),
    });
    await rides.deleteMany({});
    const copy = (customerId: unknown, code: string, requestedAt: Date) => ({
      ...template,
      _id: new Types.ObjectId(),
      customerId,
      rideCode: code,
      status: "CANCELLED",
      isActive: false,
      requestedAt,
    });
    // 25 rides, one every 3 hours going back from now (~3 days).
    const docs = [];
    for (let i = 0; i < 25; i++) {
      const at = new Date(now - i * 3 * HOUR - 60_000);
      const code = `TRHIST${String(i).padStart(4, "0")}`;
      seeded.set(code, at);
      docs.push(copy(template!.customerId, code, at));
    }
    docs.push(copy(new Types.ObjectId(), "TRSOMEONE", new Date(now - HOUR)));
    await rides.insertMany(docs);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
    process.chdir(originalCwd);
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  it("pages through the caller's rides, newest first, without gaps or repeats", async () => {
    const codes: string[] = [];
    let page = 1;
    let body: HistoryPage;
    do {
      body = await history("customer", { page, limit: 10 });
      expect(body.total).toBe(25);
      expect(body.page).toBe(page);
      codes.push(...body.items.map((ride) => ride.rideCode));
      page++;
    } while (body.hasMore);
    expect(page - 1).toBe(3);
    expect(codes).toEqual([...seeded.keys()]);
    expect((await history("other", {})).total).toBe(0);
  });

  it("filters by a requestedAt window: start inclusive, end exclusive", async () => {
    const sinceYesterday = await history("customer", {
      startDate: new Date(now - DAY).toISOString(),
      limit: 50,
    });
    const expected = [...seeded]
      .filter(([, at]) => at.getTime() >= now - DAY)
      .map(([code]) => code);
    expect(sinceYesterday.items.map((ride) => ride.rideCode)).toEqual(expected);
    expect(sinceYesterday.total).toBe(expected.length);

    const third = seeded.get("TRHIST0003")!;
    const fifth = seeded.get("TRHIST0005")!;
    const window = await history("customer", {
      startDate: fifth.toISOString(),
      endDate: third.toISOString(),
    });
    expect(window.items.map((ride) => ride.rideCode)).toEqual([
      "TRHIST0004",
      "TRHIST0005",
    ]);

    // Same instant written with an IST offset.
    const ist = new Date(fifth.getTime() + 5.5 * HOUR)
      .toISOString()
      .replace("Z", "+05:30");
    const viaIst = await history("customer", {
      startDate: ist,
      endDate: third.toISOString(),
    });
    expect(viaIst.total).toBe(2);

    const paged = await history("customer", {
      startDate: new Date(now - DAY).toISOString(),
      limit: 3,
      page: 2,
    });
    expect(paged.items.map((ride) => ride.rideCode)).toEqual(
      expected.slice(3, 6),
    );
    expect(paged.hasMore).toBe(expected.length > 6);

    const empty = await history("customer", {
      endDate: new Date(now - 30 * DAY).toISOString(),
    });
    expect(empty).toMatchObject({ items: [], total: 0, hasMore: false });
  });

  it("rejects malformed or inverted ranges", async () => {
    const bad = async (query: Record<string, string>) =>
      (
        await api()
          .get("/api/v1/rides")
          .query(query)
          .set(as("customer"))
          .expect(400)
      ).body;
    await bad({ startDate: "yesterday" });
    await bad({ startDate: "2026-13-01T00:00:00Z" });
    // No offset: the server cannot know whose midnight that is.
    await bad({ startDate: "2026-09-24T00:00:00.000" });
    const inverted = await bad({
      startDate: "2026-09-25T00:00:00Z",
      endDate: "2026-09-24T00:00:00Z",
    });
    expect(inverted.code).toBe("RIDE_HISTORY_RANGE_INVALID");
    await bad({
      startDate: "2026-09-25T00:00:00Z",
      endDate: "2026-09-25T00:00:00Z",
    });
    await bad({ from: "2026-09-25T00:00:00Z" });
  });
});
