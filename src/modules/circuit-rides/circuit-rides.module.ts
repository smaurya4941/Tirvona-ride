import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { CircuitPackagesModule } from "../circuit-packages/circuit-packages.module";
import { DriverProfile, DriverProfileSchema } from "../drivers/schemas/driver-profile.schema";
import { LocationsModule } from "../locations/locations.module";
import { MatchingModule } from "../matching/matching.module";
import { RideTypesModule } from "../ride-types/ride-types.module";
import { RidesModule } from "../rides/rides.module";
import { Ride, RideSchema } from "../rides/schemas/ride.schema";
import { User, UserSchema } from "../users/schemas/user.schema";
import { UsersModule } from "../users/users.module";
import { ZonesModule } from "../zones/zones.module";
import { AdminCircuitRidesController } from "./admin-circuit-rides.controller";
import { AdminCircuitRidesService } from "./admin-circuit-rides.service";
import { CircuitExecutionService } from "./circuit-execution.service";
import { CircuitLedgerService } from "./circuit-ledger.service";
import { CircuitMonitorService } from "./circuit-monitor.service";
import { CircuitRidesController } from "./circuit-rides.controller";
import { CircuitRidesService } from "./circuit-rides.service";
import { CircuitRideEvent, CircuitRideEventSchema } from "./schemas/circuit-ride-event.schema";

// Dependency direction (no cycles):
//   CircuitRides → CircuitPackages → (Places, RideTypes, Locations, Audit)
//   CircuitRides → Rides (booking, transitions, events, views, lifecycle)
//   Rides only imports pure circuit types/schemas, never this module.
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Ride.name, schema: RideSchema },
      { name: User.name, schema: UserSchema },
      { name: DriverProfile.name, schema: DriverProfileSchema },
      { name: CircuitRideEvent.name, schema: CircuitRideEventSchema },
    ]),
    CircuitPackagesModule,
    RidesModule,
    RideTypesModule,
    LocationsModule,
    MatchingModule,
    UsersModule,
    ZonesModule,
  ],
  controllers: [CircuitRidesController, AdminCircuitRidesController],
  providers: [
    CircuitRidesService,
    CircuitExecutionService,
    CircuitMonitorService,
    CircuitLedgerService,
    AdminCircuitRidesService,
  ],
  exports: [CircuitMonitorService],
})
export class CircuitRidesModule {}
