import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { BrandingController } from "./branding.controller";
import { BrandingService } from "./branding.service";
import { BrandAsset, BrandAssetSchema } from "./schemas/brand-asset.schema";

/** Logo and splash screen. Admin upload/reset endpoints live in AdminModule. */
@Module({
  imports: [MongooseModule.forFeature([{ name: BrandAsset.name, schema: BrandAssetSchema }])],
  controllers: [BrandingController],
  providers: [BrandingService],
  exports: [BrandingService],
})
export class BrandingModule {}
