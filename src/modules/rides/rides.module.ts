import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { DriversModule } from "../drivers/drivers.module";
import { EarningsModule } from "../earnings/earnings.module";
import { LocationsModule } from "../locations/locations.module";
import { MatchingModule } from "../matching/matching.module";
import { RideConfigModule } from "../ride-config/ride-config.module";
import { RealtimeModule } from "../realtime/realtime.module";
import { PricingModule } from "../pricing/pricing.module";
import { RideTypesModule } from "../ride-types/ride-types.module";
import { UsersModule } from "../users/users.module";
import { VehiclesModule } from "../vehicles/vehicles.module";
import { CancellationsModule } from "../cancellations/cancellations.module";
import { PromotionsModule } from "../promotions/promotions.module";
import { ZonesModule } from "../zones/zones.module";
import { DriverAvailabilityController } from "./driver-availability.controller";
import { DriverAvailabilityService } from "./driver-availability.service";
import { SosEvent, SosEventSchema } from "../safety/schemas/sos-event.schema";
import { RideDispatchScheduler } from "./ride-dispatch.scheduler";
import { RideDispatchService } from "./ride-dispatch.service";
import { RideEventsService } from "./ride-events.service";
import { RideLifecycleService } from "./ride-lifecycle.service";
import { RidePaymentStateService } from "./ride-payment-state.service";
import { RideRouteService } from "./ride-route.service";
import { RiderHomeService } from "./rider-home.service";
import { RideTransitionService } from "./ride-transition.service";
import { RideViewService } from "./ride-view.service";
import { RidesAdminService } from "./rides-admin.service";
import { RidesController } from "./rides.controller";
import { RidesService } from "./rides.service";
import { Ride, RideSchema } from "./schemas/ride.schema";
import {
  RideStatusHistory,
  RideStatusHistorySchema,
} from "./schemas/ride-status-history.schema";

// Dependency direction (no cycles):
//   Rides → Matching → Drivers(model)
//   Rides → Pricing, RideTypes, Locations, Users, Drivers, Vehicles
//   Rides → Realtime → Locations   (events are pushed into Realtime)
//   Rides → Earnings(read-only, dashboard totals)
//   Rides → Zones, Promotions, Cancellations (Phase 7 leaves; outcomes flow
//           back to Promotions as ride.transitioned events)
//   Payments → Rides (RidePaymentStateService), Earnings
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Ride.name, schema: RideSchema },
      { name: RideStatusHistory.name, schema: RideStatusHistorySchema },
      // Read-only: "is an SOS open on this ride?" decides whether the
      // end-of-trip OTP is asked for. (Safety reads rides the same way.)
      { name: SosEvent.name, schema: SosEventSchema },
    ]),
    UsersModule,
    DriversModule,
    VehiclesModule,
    RideTypesModule,
    PricingModule,
    LocationsModule,
    RideConfigModule,
    MatchingModule,
    RealtimeModule,
    EarningsModule,
    // Phase 7 — service areas, promo reservation, cancellation policy/records
    ZonesModule,
    PromotionsModule,
    CancellationsModule,
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
    RideRouteService,
    RiderHomeService,
  ],
  exports: [
    RidesService,
    RidesAdminService,
    RideDispatchService,
    RideEventsService,
    RideLifecycleService,
    RidePaymentStateService,
    RideTransitionService,
    RideViewService,
  ],
})
export class RidesModule {}
