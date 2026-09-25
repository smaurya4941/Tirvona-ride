import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { DriverProfile, DriverProfileSchema } from "../drivers/schemas/driver-profile.schema";
import { Ride, RideSchema } from "../rides/schemas/ride.schema";
import { DriverLiveLocationStore } from "./driver-live-location.store";
import { DriverLocationService } from "./driver-location.service";
import { HaversineRouteEstimator } from "./haversine-route-estimator";
import { LocationsService } from "./locations.service";
import { ROUTE_ESTIMATOR } from "./route-estimator";
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
      { name: DriverLocationCheckpoint.name, schema: DriverLocationCheckpointSchema },
    ]),
  ],
  providers: [
    // Swap this binding for a road-routing provider (Google, Mapbox, OSRM…)
    // without touching RidesModule or PricingModule.
    { provide: ROUTE_ESTIMATOR, useClass: HaversineRouteEstimator },
    LocationsService,
    DriverLiveLocationStore,
    DriverLocationService,
  ],
  exports: [LocationsService, DriverLocationService],
})
export class LocationsModule {}
