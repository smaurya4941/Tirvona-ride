import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { DriverProfile, DriverProfileSchema } from "../drivers/schemas/driver-profile.schema";
import { RideConfigModule } from "../ride-config/ride-config.module";
import { MatchingService } from "./matching.service";

@Module({
  imports: [MongooseModule.forFeature([{ name: DriverProfile.name, schema: DriverProfileSchema }]), RideConfigModule],
  providers: [MatchingService],
  exports: [MatchingService],
})
export class MatchingModule {}
