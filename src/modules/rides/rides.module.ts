import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { DriversModule } from "../drivers/drivers.module";
import { EarningsModule } from "../earnings/earnings.module";
import { LocationsModule } from "../locations/locations.module";
import { MatchingModule } from "../matching/matching.module";
import { RealtimeModule } from "../realtime/realtime.module";
import { PricingModule } from "../pricing/pricing.module";
import { RideTypesModule } from "../ride-types/ride-types.module";
import { UsersModule } from "../users/users.module";
import { VehiclesModule } from "../vehicles/vehicles.module";
import { DriverAvailabilityController } from "./driver-availability.controller";
import { DriverAvailabilityService } from "./driver-availability.service";
import { RideDispatchScheduler } from "./ride-dispatch.scheduler";
import { RideDispatchService } from "./ride-dispatch.service";
import { RideEventsService } from "./ride-events.service";
import { RideLifecycleService } from "./ride-lifecycle.service";
import { RidePaymentStateService } from "./ride-payment-state.service";
import { RideTransitionService } from "./ride-transition.service";
import { RideViewService } from "./ride-view.service";
import { RidesAdminService } from "./rides-admin.service";
import { RidesController } from "./rides.controller";
import { RidesService } from "./rides.service";
import { Ride, RideSchema } from "./schemas/ride.schema";
import { RideStatusHistory, RideStatusHistorySchema } from "./schemas/ride-status-history.schema";

// Dependency direction (no cycles):
//   Rides → Matching → Drivers(model)
//   Rides → Pricing, RideTypes, Locations, Users, Drivers, Vehicles
//   Rides → Realtime → Locations   (events are pushed into Realtime)
//   Rides → Earnings(read-only, dashboard totals)
//   Payments → Rides (RidePaymentStateService), Earnings
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Ride.name, schema: RideSchema },
      { name: RideStatusHistory.name, schema: RideStatusHistorySchema },
    ]),
    UsersModule,
    DriversModule,
    VehiclesModule,
    RideTypesModule,
    PricingModule,
    LocationsModule,
    MatchingModule,
    RealtimeModule,
    EarningsModule,
  ],
  controllers: [RidesController, DriverAvailabilityController],
  providers: [
    RidesService,
    RideLifecycleService,
    RideDispatchService,
    RideDispatchScheduler,
    RideEventsService,
    RideTransitionService,
    RideViewService,
    DriverAvailabilityService,
    RidesAdminService,
    RidePaymentStateService,
  ],
  exports: [RidesAdminService, RideDispatchService, RidePaymentStateService],
})
export class RidesModule {}
