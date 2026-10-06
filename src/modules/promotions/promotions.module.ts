import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { RideConfigModule } from "../ride-config/ride-config.module";
import { PricingModule } from "../pricing/pricing.module";
import { RideTypesModule } from "../ride-types/ride-types.module";
import { PromoRideEventsListener } from "./promo-ride-events.listener";
import { PromotionsController } from "./promotions.controller";
import { PromotionsService } from "./promotions.service";
import {
  PromoCode,
  PromoCodeSchema,
  PromoRedemption,
  PromoRedemptionSchema,
} from "./schemas/promo-code.schema";

// Rides → Promotions (reserve at booking). Promotions never imports Rides:
// ride outcomes arrive as domain events.
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: PromoCode.name, schema: PromoCodeSchema },
      { name: PromoRedemption.name, schema: PromoRedemptionSchema },
    ]),
    RideTypesModule,
    RideConfigModule,
    PricingModule,
  ],
  controllers: [PromotionsController],
  providers: [PromotionsService, PromoRideEventsListener],
  exports: [PromotionsService, MongooseModule],
})
export class PromotionsModule {}
