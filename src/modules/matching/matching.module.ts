import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { DriverProfile, DriverProfileSchema } from "../drivers/schemas/driver-profile.schema";
import { MatchingService } from "./matching.service";

@Module({
  imports: [MongooseModule.forFeature([{ name: DriverProfile.name, schema: DriverProfileSchema }])],
  providers: [MatchingService],
  exports: [MatchingService],
})
export class MatchingModule {}
