import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { AuthModule } from "../auth/auth.module";
import { BrandingModule } from "../branding/branding.module";
import { CancellationsModule } from "../cancellations/cancellations.module";
import { ComplaintsModule } from "../complaints/complaints.module";
import { SupportTicket, SupportTicketSchema } from "../complaints/schemas/support-ticket.schema";
import { DriversModule } from "../drivers/drivers.module";
import { LocationsModule } from "../locations/locations.module";
import { EarningsModule } from "../earnings/earnings.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { PaymentsModule } from "../payments/payments.module";
import { PlacesModule } from "../places/places.module";
import { Payment, PaymentSchema } from "../payments/schemas/payment.schema";
import { PricingModule } from "../pricing/pricing.module";
import { PromotionsModule } from "../promotions/promotions.module";
import { ReportsModule } from "../reports/reports.module";
import { RideConfigModule } from "../ride-config/ride-config.module";
import { RideTypesModule } from "../ride-types/ride-types.module";
import { RidesModule } from "../rides/rides.module";
import { Ride, RideSchema } from "../rides/schemas/ride.schema";
import { SafetyModule } from "../safety/safety.module";
import { UsersModule } from "../users/users.module";
import { VehiclesModule } from "../vehicles/vehicles.module";
import { ZonesModule } from "../zones/zones.module";
import {
  AdminBroadcastsController,
  AdminCancellationsController,
  AdminPromotionsController,
  AdminZonesController,
} from "./admin-operations.controller";
import {
  AdminCommissionController,
  AdminEarningsController,
  AdminPaymentsController,
} from "./admin-payments.controller";
import { AdminBrandingController } from "./admin-branding.controller";
import { AdminPopularPlacesController } from "./admin-places.controller";
import { AdminLiveController } from "./admin-live.controller";
import { AdminLiveService } from "./admin-live.service";
import { AdminPeakPricingController } from "./admin-peak-pricing.controller";
import { AdminRideConfigController } from "./admin-ride-config.controller";
import { AdminPeopleService } from "./admin-people.service";
import { AdminPricingController } from "./admin-pricing.controller";
import { AdminComplaintsController, AdminSosController } from "./admin-safety.controller";
import { AdminRidesController } from "./admin-rides.controller";
import { AdminController } from "./admin.controller";
import { AdminService } from "./admin.service";

/**
 * Every /admin route. Each controller is class-level @Roles(ADMIN); the
 * authorization audit test (test/phase7.e2e-spec.ts) fails the build if an
 * /admin route is ever added without it.
 */
@Module({
  imports: [
    // Read-only models for the admin customer/vehicle views.
    MongooseModule.forFeature([
      { name: Ride.name, schema: RideSchema },
      { name: Payment.name, schema: PaymentSchema },
      { name: SupportTicket.name, schema: SupportTicketSchema },
    ]),
    AuthModule,
    UsersModule,
    DriversModule,
    VehiclesModule,
    RideTypesModule,
    PricingModule,
    RidesModule,
    PaymentsModule,
    EarningsModule,
    SafetyModule,
    ComplaintsModule,
    NotificationsModule,
    ZonesModule,
    PromotionsModule,
    CancellationsModule,
    ReportsModule,
    BrandingModule,
    PlacesModule,
    LocationsModule,
    RideConfigModule,
  ],
  controllers: [
    AdminController,
    AdminLiveController,
    AdminPeakPricingController,
    AdminRidesController,
    AdminPricingController,
    AdminRideConfigController,
    AdminPaymentsController,
    AdminCommissionController,
    AdminEarningsController,
    AdminSosController,
    AdminComplaintsController,
    AdminZonesController,
    AdminPromotionsController,
    AdminCancellationsController,
    AdminBroadcastsController,
    AdminBrandingController,
    AdminPopularPlacesController,
  ],
  providers: [AdminService, AdminPeopleService, AdminLiveService],
})
export class AdminModule {}
