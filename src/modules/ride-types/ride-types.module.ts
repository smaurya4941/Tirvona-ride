import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { RideTypesController } from "./ride-types.controller";
import { RideTypesService } from "./ride-types.service";
import { RideType, RideTypeSchema } from "./schemas/ride-type.schema";

@Module({
  imports: [MongooseModule.forFeature([{ name: RideType.name, schema: RideTypeSchema }])],
  controllers: [RideTypesController],
  providers: [RideTypesService],
  exports: [RideTypesService],
})
export class RideTypesModule {}
