import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectConnection } from "@nestjs/mongoose";
import type Redis from "ioredis";
import type { Connection } from "mongoose";
import { REDIS_CLIENT } from "../../../infrastructure/redis/redis.constants";

export type DependencyStatus = "up" | "down" | "disabled";

export interface HealthReport {
  service: string;
  status: "ready" | "degraded";
  environment: string;
  uptimeSeconds: number;
  checks: {
    database: DependencyStatus;
    redis: DependencyStatus;
  };
  timestamp: string;
}

const PROBE_TIMEOUT_MS = 2_000;

const withTimeout = async <T>(work: Promise<T>): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("probe timed out")),
      PROBE_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
};

@Injectable()
export class HealthService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @Inject(REDIS_CLIENT) private readonly redis: Redis | null,
    private readonly config: ConfigService,
  ) {}

  liveness(): Pick<HealthReport, "service" | "timestamp"> {
    return {
      service: this.config.getOrThrow<string>("serviceName"),
      timestamp: new Date().toISOString(),
    };
  }

  async readiness(): Promise<HealthReport> {
    const [database, redis] = await Promise.all([
      this.checkDatabase(),
      this.checkRedis(),
    ]);
    return {
      service: this.config.getOrThrow<string>("serviceName"),
      status: database === "up" && redis !== "down" ? "ready" : "degraded",
      environment: this.config.getOrThrow<string>("nodeEnv"),
      uptimeSeconds: Math.round(process.uptime()),
      checks: { database, redis },
      timestamp: new Date().toISOString(),
    };
  }

  private async checkDatabase(): Promise<DependencyStatus> {
    try {
      if (this.connection.readyState !== 1 || !this.connection.db)
        return "down";
      await withTimeout(this.connection.db.admin().ping());
      return "up";
    } catch {
      return "down";
    }
  }

  private async checkRedis(): Promise<DependencyStatus> {
    if (!this.redis) return "disabled";
    try {
      await withTimeout(this.redis.ping());
      return "up";
    } catch {
      return "down";
    }
  }
}
