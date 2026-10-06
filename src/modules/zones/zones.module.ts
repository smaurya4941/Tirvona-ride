import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { Zone, ZoneSchema } from "./schemas/zone.schema";
import { ZonesService } from "./zones.service";

/** Service areas. Admin endpoints live in AdminModule; rides use ZonesService at booking. */
@Module({
  imports: [
    MongooseModule.forFeature([{ name: Zone.name, schema: ZoneSchema }]),
  ],
  providers: [ZonesService],
  exports: [ZonesService, MongooseModule],
})
export class ZonesModule {}
