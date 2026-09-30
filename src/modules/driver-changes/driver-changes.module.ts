import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { DriversModule } from "../drivers/drivers.module";
import { UsersModule } from "../users/users.module";
import { VehiclesModule } from "../vehicles/vehicles.module";
import { AdminDriverChangesController, DriverChangesController } from "./driver-changes.controller";
import { DriverChangesService } from "./driver-changes.service";
import { DriverChangeRequest, DriverChangeRequestSchema } from "./schemas/driver-change-request.schema";

/**
 * Changes approved drivers ask for to verified details (licence, vehicle,
 * documents), and the admin review that applies them. The profile, vehicle
 * and document models come from their own modules.
 */
@Module({
  imports: [
    MongooseModule.forFeature([{ name: DriverChangeRequest.name, schema: DriverChangeRequestSchema }]),
    DriversModule,
    VehiclesModule,
    UsersModule,
  ],
  controllers: [DriverChangesController, AdminDriverChangesController],
  providers: [DriverChangesService],
  exports: [DriverChangesService],
})
export class DriverChangesModule {}
