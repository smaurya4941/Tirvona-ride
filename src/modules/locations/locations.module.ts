import { Logger, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { MongooseModule } from "@nestjs/mongoose";
import type { RoutesProviderName } from "../../config/environment";
import {
  DriverProfile,
  DriverProfileSchema,
} from "../drivers/schemas/driver-profile.schema";
import { Ride, RideSchema } from "../rides/schemas/ride.schema";
import { DriverLiveLocationStore } from "./driver-live-location.store";
import { DriverLocationService } from "./driver-location.service";
import { GoogleRoutesEstimator } from "./google-routes-estimator";
import { HaversineRouteEstimator } from "./haversine-route-estimator";
import { LiveRouteService } from "./live-route.service";
import { LocationsService } from "./locations.service";
import { ResilientRouteEstimator } from "./resilient-route-estimator";
import { ROUTE_ESTIMATOR } from "./route-estimator";
import type { RouteEstimator } from "./route-estimator";

/**
 * ROUTES_PROVIDER=google (the default once GOOGLE_ROUTES_API_KEY is set):
 * Google Routes behind a cache, circuit breaker and straight-line fallback.
 * ROUTES_PROVIDER=haversine: straight-line estimates only.
 */
function routeEstimatorFactory(
  config: ConfigService,
  google: GoogleRoutesEstimator,
  haversine: HaversineRouteEstimator,
): RouteEstimator {
  const provider = config.getOrThrow<RoutesProviderName>("routesProvider");
  if (provider !== "google") {
    new Logger(LocationsModule.name).log(
      "Routing: straight-line (Haversine) estimates",
    );
    return haversine;
  }
  new Logger(LocationsModule.name).log(
    "Routing: Google Routes API with straight-line fallback",
  );
  return new ResilientRouteEstimator(google, haversine, {
    cacheTtlMs: config.getOrThrow<number>("routesCacheTtlSeconds") * 1000,
    cacheMaxEntries: config.getOrThrow<number>("routesCacheMaxEntries"),
    failureThreshold: config.getOrThrow<number>("routesFailureThreshold"),
    cooldownMs:
      config.getOrThrow<number>("routesFailureCooldownSeconds") * 1000,
  });
}
import {
  DriverLocationCheckpoint,
  DriverLocationCheckpointSchema,
} from "./schemas/driver-location-checkpoint.schema";

// Leaf module: registers the driver/ride models it reads by schema only, so
// Rides, Matching and Realtime can all depend on it without a cycle.
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: DriverProfile.name, schema: DriverProfileSchema },
      { name: Ride.name, schema: RideSchema },
      {
        name: DriverLocationCheckpoint.name,
        schema: DriverLocationCheckpointSchema,
      },
    ]),
  ],
  providers: [
    // Rides and pricing depend only on ROUTE_ESTIMATOR; another provider
    // (Mapbox, OSRM…) means another implementation here, nothing else.
    GoogleRoutesEstimator,
    HaversineRouteEstimator,
    {
      provide: ROUTE_ESTIMATOR,
      useFactory: routeEstimatorFactory,
      inject: [ConfigService, GoogleRoutesEstimator, HaversineRouteEstimator],
    },
    LocationsService,
    LiveRouteService,
    DriverLiveLocationStore,
    DriverLocationService,
  ],
  exports: [LocationsService, LiveRouteService, DriverLocationService],
})
export class LocationsModule {}
