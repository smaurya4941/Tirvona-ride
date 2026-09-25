import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import type { App } from "supertest/types";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/app.setup";

// Requires a reachable MongoDB (MONGODB_URI, default mongodb://127.0.0.1:27017).
// Uses a dedicated database so it never touches local development data.
describe("Tirvona Rides API (e2e)", () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    process.env.MONGODB_DB_NAME = "tirvona_ride_test";
    process.env.LOG_LEVEL = "silent";
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it("GET /api/v1/health/live reports the process is alive", async () => {
    const response = await request(app.getHttpServer())
      .get("/api/v1/health/live")
      .expect(200);
    expect(response.body).toMatchObject({
      success: true,
      data: { service: "tirvona-ride-api" },
    });
    expect(response.headers["x-request-id"]).toBeDefined();
  });

  it("GET /api/v1/health reports MongoDB as up", async () => {
    // 200 when Redis is up or disabled, 503 when a configured Redis is down;
    // both carry the full report.
    const response = await request(app.getHttpServer()).get("/api/v1/health");
    expect([200, 503]).toContain(response.status);
    expect(response.body.data.checks.database).toBe("up");
  });

  it("echoes a safe client request id", async () => {
    const response = await request(app.getHttpServer())
      .get("/api/v1/health/live")
      .set("X-Request-Id", "flutter-test-1")
      .expect(200);
    expect(response.headers["x-request-id"]).toBe("flutter-test-1");
  });

  it("returns the standard error envelope for unknown routes", async () => {
    const response = await request(app.getHttpServer())
      .get("/api/v1/does-not-exist")
      .expect(404);
    expect(response.body).toMatchObject({
      success: false,
      path: "/api/v1/does-not-exist",
    });
    expect(response.body.requestId).toBeDefined();
  });
});
