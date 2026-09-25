import { Global, Inject, Logger, Module } from "@nestjs/common";
import type { OnApplicationShutdown } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";
import { REDIS_CLIENT } from "./redis.constants";

const logger = new Logger("Redis");

// Resolves to null when REDIS_URL is unset, which is only permitted outside
// production (see validateEnvironment). Consumers must handle the null case.
const createRedisClient = (config: ConfigService): Redis | null => {
  const url = config.get<string>("redisUrl");
  if (!url) {
    logger.warn("REDIS_URL is not set; Redis-backed features are disabled");
    return null;
  }
  const client = new Redis(url, {
    keyPrefix: config.get<string>("redisKeyPrefix"),
    connectionName: config.get<string>("serviceName"),
    connectTimeout: 5_000,
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false,
    retryStrategy: (attempt) => Math.min(attempt * 500, 10_000),
  });
  let reportedDown = false;
  client.on("ready", () => {
    reportedDown = false;
    logger.log("Connected");
  });
  client.on("error", (error: Error) => {
    if (reportedDown) return;
    reportedDown = true;
    logger.warn(`Unavailable: ${error.message}`);
  });
  return client;
};

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: createRedisClient,
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis | null) {}

  async onApplicationShutdown(): Promise<void> {
    if (!this.redis) return;
    await this.redis.quit().catch(() => this.redis?.disconnect());
  }
}
