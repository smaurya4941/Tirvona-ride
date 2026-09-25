import { ConfigService } from "@nestjs/config";
import type Redis from "ioredis";
import type { Connection } from "mongoose";
import { HealthService } from "./health.service";

const config = new ConfigService({
  serviceName: "tirvona-ride-api",
  nodeEnv: "test",
});

const connection = (
  readyState: number,
  ping = jest.fn().mockResolvedValue({ ok: 1 }),
) => ({ readyState, db: { admin: () => ({ ping }) } }) as unknown as Connection;

const redis = (ping: jest.Mock) => ({ ping }) as unknown as Redis;

describe("HealthService.readiness", () => {
  it("is ready when MongoDB and Redis respond", async () => {
    const service = new HealthService(
      connection(1),
      redis(jest.fn().mockResolvedValue("PONG")),
      config,
    );
    const report = await service.readiness();
    expect(report.status).toBe("ready");
    expect(report.checks).toEqual({ database: "up", redis: "up" });
  });

  it("is ready with Redis disabled (no REDIS_URL in development)", async () => {
    const report = await new HealthService(
      connection(1),
      null,
      config,
    ).readiness();
    expect(report.status).toBe("ready");
    expect(report.checks.redis).toBe("disabled");
  });

  it("is degraded when MongoDB is disconnected", async () => {
    const report = await new HealthService(
      connection(0),
      null,
      config,
    ).readiness();
    expect(report.status).toBe("degraded");
    expect(report.checks.database).toBe("down");
  });

  it("is degraded when the MongoDB ping fails", async () => {
    const ping = jest.fn().mockRejectedValue(new Error("boom"));
    const report = await new HealthService(
      connection(1, ping),
      null,
      config,
    ).readiness();
    expect(report.checks.database).toBe("down");
  });

  it("is degraded when a configured Redis is unreachable", async () => {
    const service = new HealthService(
      connection(1),
      redis(jest.fn().mockRejectedValue(new Error("ECONNREFUSED"))),
      config,
    );
    const report = await service.readiness();
    expect(report.status).toBe("degraded");
    expect(report.checks.redis).toBe("down");
  });
});
