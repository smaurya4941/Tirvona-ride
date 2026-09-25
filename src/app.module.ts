import { Module, RequestMethod } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerModule } from "@nestjs/throttler";
import { LoggerModule } from "nestjs-pino";
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { HttpThrottlerGuard } from "./common/guards/http-throttler.guard";
import { environment, validateEnvironment } from "./config/environment";
import { DatabaseModule } from "./infrastructure/database/database.module";
import { DomainEventsModule } from "./infrastructure/events/domain-events.module";
import { RedisModule } from "./infrastructure/redis/redis.module";
import { AdminModule } from "./modules/admin/admin.module";
import { AuthModule } from "./modules/auth/auth.module";
import { ComplaintsModule } from "./modules/complaints/complaints.module";
import { DriversModule } from "./modules/drivers/drivers.module";
import { EarningsModule } from "./modules/earnings/earnings.module";
import { HealthModule } from "./modules/health/health.module";
import { LocationsModule } from "./modules/locations/locations.module";
import { MatchingModule } from "./modules/matching/matching.module";
import { NotificationsModule } from "./modules/notifications/notifications.module";
import { PlacesModule } from "./modules/places/places.module";
import { PaymentsModule } from "./modules/payments/payments.module";
import { PricingModule } from "./modules/pricing/pricing.module";
import { RatingsModule } from "./modules/ratings/ratings.module";
import { RealtimeModule } from "./modules/realtime/realtime.module";
import { RideTypesModule } from "./modules/ride-types/ride-types.module";
import { RidesModule } from "./modules/rides/rides.module";
import { SafetyModule } from "./modules/safety/safety.module";
import { UsersModule } from "./modules/users/users.module";
import { VehiclesModule } from "./modules/vehicles/vehicles.module";

/**
 * Per-environment settings files, most specific first; real environment
 * variables always win over any file. Local development never reads
 * .env.production, so production credentials cannot leak into it.
 */
const ENV_FILES: Record<string, string[]> = {
  development: [".env.local", ".env"],
  test: [".env.test"],
  production: [".env.production", ".env"],
};

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      envFilePath: ENV_FILES[process.env.NODE_ENV || "development"] ?? [".env"],
      load: [environment],
      validate: validateEnvironment,
    }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        // Nest 11 / path-to-regexp v8 syntax; the library default "*" logs a
        // legacy-route warning on every boot.
        forRoutes: [{ path: "{*path}", method: RequestMethod.ALL }],
        pinoHttp: {
          level: config.get<string>("logLevel"),
          transport:
            config.get<string>("nodeEnv") === "development"
              ? {
                  target: "pino-pretty",
                  options: { singleLine: true, ignore: "pid,hostname" },
                }
              : undefined,
          // Reuse the id assigned by requestIdMiddleware so log lines and
          // error bodies carry the same value.
          genReqId: (request: IncomingMessage) =>
            (request as IncomingMessage & { id?: string }).id ?? randomUUID(),
          autoLogging: {
            ignore: (request: IncomingMessage) =>
              request.url?.includes("/health") ?? false,
          },
          // Share-ride tokens are bearer secrets: keep them out of access logs.
          serializers: {
            req: (req: { url?: string }) => ({
              ...req,
              url: req.url?.replace(/(shared-rides\/(?:view\/)?)[^/?#]+/, "$1[token]"),
            }),
          },
          redact: [
            "req.headers.authorization",
            "req.headers.cookie",
            "req.body.password",
            "req.body.otp",
            "req.body.refreshToken",
            "res.headers['set-cookie']",
          ],
        },
      }),
    }),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => [
        {
          name: "default",
          ttl: config.getOrThrow<number>("throttleTtlMs"),
          limit: config.getOrThrow<number>("throttleLimit"),
        },
      ],
    }),
    DatabaseModule,
    RedisModule,
    DomainEventsModule,
    HealthModule,
    AuthModule,
    UsersModule,
    DriversModule,
    VehiclesModule,
    // Phase 2 — ride booking
    RideTypesModule,
    PricingModule,
    LocationsModule,
    MatchingModule,
    RidesModule,
    // Phase 3 — realtime layer (WebSocket gateway; MongoDB-backed, no Redis)
    RealtimeModule,
    // Phase 4 — payments (Razorpay) and the driver earnings ledger
    EarningsModule,
    PaymentsModule,
    // Phase 5 — ratings, notifications (in-app + FCM), safety, complaints
    NotificationsModule,
    RatingsModule,
    SafetyModule,
    ComplaintsModule,
    // Place search for the booking flow (autocomplete, reverse geocoding)
    PlacesModule,
    AdminModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: HttpThrottlerGuard }],
})
export class AppModule {}
