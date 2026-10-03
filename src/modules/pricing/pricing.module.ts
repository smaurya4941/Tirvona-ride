import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { PeakPricingService } from "./peak-pricing.service";
import { PricingService } from "./pricing.service";
import { PeakPricingSlot, PeakPricingSlotSchema } from "./schemas/peak-pricing-slot.schema";
import { PricingConfig, PricingConfigSchema } from "./schemas/pricing-config.schema";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: PricingConfig.name, schema: PricingConfigSchema },
      { name: PeakPricingSlot.name, schema: PeakPricingSlotSchema },
    ]),
  ],
  providers: [PricingService, PeakPricingService],
  exports: [PricingService, PeakPricingService],
})
export class PricingModule {}
