import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { PricingService } from "./pricing.service";
import { PricingConfig, PricingConfigSchema } from "./schemas/pricing-config.schema";

@Module({
  imports: [MongooseModule.forFeature([{ name: PricingConfig.name, schema: PricingConfigSchema }])],
  providers: [PricingService],
  exports: [PricingService],
})
export class PricingModule {}
