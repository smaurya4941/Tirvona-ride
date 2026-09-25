import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import {
  DriverDocument,
  DriverDocumentSchema,
} from "./schemas/driver-document.schema";
import {
  DriverProfile,
  DriverProfileSchema,
} from "./schemas/driver-profile.schema";
import { Vehicle, VehicleSchema } from "../vehicles/schemas/vehicle.schema";
import { DriversController } from "./drivers.controller";
import { DriversService } from "./drivers.service";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: DriverProfile.name, schema: DriverProfileSchema },
      { name: DriverDocument.name, schema: DriverDocumentSchema },
      // Read-only cross-check in DriversService#submitKyc (driver must have
      // an active vehicle). Kept as a model injection instead of importing
      // VehiclesModule to avoid a circular module dependency.
      { name: Vehicle.name, schema: VehicleSchema },
    ]),
  ],
  controllers: [DriversController],
  providers: [DriversService],
  exports: [DriversService, MongooseModule],
})
export class DriversModule {}
