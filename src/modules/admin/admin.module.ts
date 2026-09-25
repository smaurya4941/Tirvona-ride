import { Module } from "@nestjs/common";
import { ComplaintsModule } from "../complaints/complaints.module";
import { DriversModule } from "../drivers/drivers.module";
import { EarningsModule } from "../earnings/earnings.module";
import { PaymentsModule } from "../payments/payments.module";
import { PricingModule } from "../pricing/pricing.module";
import { RideTypesModule } from "../ride-types/ride-types.module";
import { RidesModule } from "../rides/rides.module";
import { SafetyModule } from "../safety/safety.module";
import { UsersModule } from "../users/users.module";
import { VehiclesModule } from "../vehicles/vehicles.module";
import {
  AdminCommissionController,
  AdminEarningsController,
  AdminPaymentsController,
} from "./admin-payments.controller";
import { AdminPricingController } from "./admin-pricing.controller";
import { AdminComplaintsController, AdminSosController } from "./admin-safety.controller";
import { AdminRidesController } from "./admin-rides.controller";
import { AdminController } from "./admin.controller";
import { AdminService } from "./admin.service";

@Module({
  imports: [
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
  ],
  controllers: [
    AdminController,
    AdminRidesController,
    AdminPricingController,
    AdminPaymentsController,
    AdminCommissionController,
    AdminEarningsController,
    AdminSosController,
    AdminComplaintsController,
  ],
  providers: [AdminService],
})
export class AdminModule {}
