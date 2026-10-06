import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import type { App } from "supertest/types";
import { PushGateway } from "../src/modules/notifications/push/push.gateway";
import type {
  PushMessage,
  PushResult,
} from "../src/modules/notifications/push/push.gateway";

/**
 * Branding: admins replace/reset the logo and splash screen; everyone
 * (signed in or not) reads them; the image endpoint is cache-friendly.
 */

const PASSWORD = "Password@123";
const PHONES = { admin: "+919880000000", customer: "+919880000001" };

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

/** A PNG header padded with a marker so two uploads differ byte-wise. */
function png(
  width: number,
  height: number,
  marker = "a",
  padding = 64,
): Buffer {
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write("IHDR", 12, "ascii");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return Buffer.concat([header, Buffer.alloc(padding, marker)]);
}

describe("Branding (e2e)", () => {
  const originalCwd = process.cwd();
  let workDir: string;
  let mongo: MongoMemoryServer;
  let app: INestApplication<App>;
  const tokens: Record<string, string> = {};

  const api = () => request(app.getHttpServer());
  const as = (who: keyof typeof PHONES) => ({
    Authorization: `Bearer ${tokens[who]}`,
  });

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create({
      instance: { launchTimeout: 60_000 },
    });
    workDir = await mkdtemp(join(tmpdir(), "tirvona-ride-branding-"));
    process.chdir(workDir);
    Object.assign(process.env, {
      NODE_ENV: "test",
      // Older suites assert final fare = estimate; actual-trip pricing is in payments-v2.
      FINAL_FARE_MODE: "booked",
      LOG_LEVEL: "silent",
      SWAGGER_ENABLED: "false",
      MONGODB_URI: mongo.getUri(),
      MONGODB_DB_NAME: "tirvona_ride_branding",
      REDIS_URL: "",
      THROTTLE_LIMIT: "5000",
      THROTTLE_AUTH_LIMIT: "1000",
      THROTTLE_ADMIN_LOGIN_LIMIT: "1000",
      JWT_ACCESS_SECRET: randomBytes(48).toString("base64url"),
      JWT_REFRESH_SECRET: randomBytes(48).toString("base64url"),
      MATCHING_SWEEP_INTERVAL_MS: "0",
      PAYMENT_RECONCILE_INTERVAL_MS: "0",
      BROADCAST_WORKER_INTERVAL_MS: "0",
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

    const { UsersService } = await import("../src/modules/users/users.service");
    const { UserRole } = await import("../src/common/types/user-role.enum");
    const users = app.get(UsersService, { strict: false });
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
      firstName: "Sachin",
    });
    for (const who of Object.keys(PHONES) as Array<keyof typeof PHONES>) {
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

  it("starts on the bundled defaults, readable without signing in", async () => {
    const response = await api().get("/api/v1/branding").expect(200);
    expect(response.body.data).toEqual({ logo: null, splash: null });
    expect(
      (await api().get("/api/v1/branding/assets/logo").expect(404)).body.code,
    ).toBe("BRANDING_NOT_SET");
    await api().get("/api/v1/branding/assets/favicon").expect(400);
  });

  it("only lets admins change branding", async () => {
    await api().get("/api/v1/admin/branding").expect(401);
    await api().get("/api/v1/admin/branding").set(as("customer")).expect(403);
    await api()
      .put("/api/v1/admin/branding/logo")
      .set(as("customer"))
      .attach("file", png(1200, 800), {
        filename: "logo.png",
        contentType: "image/png",
      })
      .expect(403);
    await api()
      .delete("/api/v1/admin/branding/logo")
      .set(as("customer"))
      .expect(403);

    const rules = (
      await api().get("/api/v1/admin/branding").set(as("admin")).expect(200)
    ).body.data.rules;
    expect(rules.map((entry: { kind: string }) => entry.kind)).toEqual([
      "logo",
      "splash",
    ]);
  });

  it("validates the image by its bytes, not its name", async () => {
    const reject = async (
      kind: string,
      body: Buffer,
      filename: string,
      contentType = "image/png",
    ) => {
      const response = await api()
        .put(`/api/v1/admin/branding/${kind}`)
        .set(as("admin"))
        .attach("file", body, { filename, contentType })
        .expect(400);
      expect(response.body.code).toBe("BRANDING_INVALID_IMAGE");
      return response.body.message as string;
    };
    expect(await reject("logo", Buffer.from("<svg/>"), "logo.png")).toMatch(
      /PNG, JPEG or WEBP/,
    );
    expect(await reject("logo", png(120, 60), "tiny.png")).toMatch(
      /at least 400/,
    );
    expect(await reject("splash", png(1920, 1080), "landscape.png")).toMatch(
      /at least 720 × 1280/,
    );
    expect(await reject("splash", png(1300, 1400), "square.png")).toMatch(
      /portrait/,
    );
    await api().put("/api/v1/admin/branding/logo").set(as("admin")).expect(400);

    await api()
      .put("/api/v1/admin/branding/splash")
      .set(as("admin"))
      .attach("file", png(1080, 2340, "x", 3 * 1024 * 1024 + 1), {
        filename: "huge.png",
        contentType: "image/png",
      })
      .expect(413);
    expect((await api().get("/api/v1/branding").expect(200)).body.data).toEqual(
      { logo: null, splash: null },
    );
  });

  it("publishes an uploaded logo and splash with cache-friendly URLs", async () => {
    const logo = png(1349, 911, "l");
    const uploaded = await api()
      .put("/api/v1/admin/branding/logo")
      .set(as("admin"))
      .attach("file", logo, {
        filename: "new-logo.png",
        contentType: "image/png",
      })
      .expect(200);
    expect(uploaded.body.data).toMatchObject({
      kind: "logo",
      width: 1349,
      height: 911,
      contentType: "image/png",
      bytes: logo.length,
    });
    const version = uploaded.body.data.version as string;
    expect(uploaded.body.data.path).toBe(`/branding/assets/logo?v=${version}`);

    await api()
      .put("/api/v1/admin/branding/splash")
      .set(as("admin"))
      .attach("file", png(1080, 2340, "s"), {
        filename: "splash.jpg",
        contentType: "image/jpeg",
      })
      .expect(200);

    const branding = (await api().get("/api/v1/branding").expect(200)).body
      .data;
    expect(branding.logo.version).toBe(version);
    expect(branding.splash).toMatchObject({
      kind: "splash",
      width: 1080,
      height: 2340,
      contentType: "image/png",
    });

    const image = await api()
      .get(`/api/v1${branding.logo.path}`)
      .buffer(true)
      .expect(200);
    expect(image.headers["content-type"]).toBe("image/png");
    expect(image.headers["cache-control"]).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(image.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    expect(image.headers.etag).toBe(`"${version}"`);
    expect(Buffer.compare(image.body as Buffer, logo)).toBe(0);

    // A stale or missing version is only briefly cacheable.
    const stale = await api()
      .get("/api/v1/branding/assets/logo?v=old")
      .expect(200);
    expect(stale.headers["cache-control"]).toBe("public, max-age=60");
    await api()
      .get("/api/v1/branding/assets/logo")
      .set("If-None-Match", `"${version}"`)
      .expect(304);
  });

  it("changes the version when the image changes, and resets to the default", async () => {
    const before = (await api().get("/api/v1/branding").expect(200)).body.data
      .logo.version as string;
    const replaced = await api()
      .put("/api/v1/admin/branding/logo")
      .set(as("admin"))
      .attach("file", png(1000, 675, "m"), {
        filename: "logo-2.png",
        contentType: "image/png",
      })
      .expect(200);
    expect(replaced.body.data.version).not.toBe(before);

    const reset = await api()
      .delete("/api/v1/admin/branding/logo")
      .set(as("admin"))
      .expect(200);
    expect(reset.body.data.logo).toBeNull();
    expect(reset.body.data.splash).not.toBeNull();
    await api().get("/api/v1/branding/assets/logo").expect(404);
    // Resetting again is a no-op, not an error.
    await api()
      .delete("/api/v1/admin/branding/logo")
      .set(as("admin"))
      .expect(200);

    const audit = await api()
      .get("/api/v1/admin/audit-logs?targetType=BRANDING&limit=20")
      .set(as("admin"))
      .expect(200);
    const actions = audit.body.data.items.map(
      (entry: { action: string; targetId: string }) =>
        `${entry.action}:${entry.targetId}`,
    );
    expect(
      actions.filter((action: string) => action === "branding.update:logo"),
    ).toHaveLength(2);
    expect(actions).toContain("branding.update:splash");
    expect(
      actions.filter((action: string) => action === "branding.reset:logo"),
    ).toHaveLength(1);
  });
});
