import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import {
  Cancellation,
  CancellationSchema,
} from "../cancellations/schemas/cancellation.schemas";
import {
  DriverProfile,
  DriverProfileSchema,
} from "../drivers/schemas/driver-profile.schema";
import {
  DriverEarning,
  DriverEarningSchema,
} from "../earnings/schemas/driver-earning.schema";
import { Payment, PaymentSchema } from "../payments/schemas/payment.schema";
import {
  PromoCode,
  PromoCodeSchema,
  PromoRedemption,
  PromoRedemptionSchema,
} from "../promotions/schemas/promo-code.schema";
import { Ride, RideSchema } from "../rides/schemas/ride.schema";
import { User, UserSchema } from "../users/schemas/user.schema";
import { ReportsController } from "./reports.controller";
import { ReportsService } from "./reports.service";

// Read-only leaf: registers every model it aggregates by schema, so reports
// never pull service modules (or their side effects) into the graph.
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Ride.name, schema: RideSchema },
      { name: User.name, schema: UserSchema },
      { name: DriverProfile.name, schema: DriverProfileSchema },
      { name: Payment.name, schema: PaymentSchema },
      { name: DriverEarning.name, schema: DriverEarningSchema },
      { name: Cancellation.name, schema: CancellationSchema },
      { name: PromoCode.name, schema: PromoCodeSchema },
      { name: PromoRedemption.name, schema: PromoRedemptionSchema },
    ]),
  ],
  controllers: [ReportsController],
  providers: [ReportsService],
  exports: [ReportsService],
})
export class ReportsModule {}
