import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { DriversModule } from "../drivers/drivers.module";
import {
  VehicleDocument,
  VehicleDocumentSchema,
} from "./schemas/vehicle-document.schema";
import { Vehicle, VehicleSchema } from "./schemas/vehicle.schema";
import { VehiclesController } from "./vehicles.controller";
import { VehiclesService } from "./vehicles.service";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Vehicle.name, schema: VehicleSchema },
      { name: VehicleDocument.name, schema: VehicleDocumentSchema },
    ]),
    DriversModule,
  ],
  controllers: [VehiclesController],
  providers: [VehiclesService],
  exports: [VehiclesService, MongooseModule],
})
export class VehiclesModule {}
