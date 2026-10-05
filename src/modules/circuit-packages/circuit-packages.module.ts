import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { AuditModule } from "../audit/audit.module";
import { LocationsModule } from "../locations/locations.module";
import { PlacesModule } from "../places/places.module";
import { RideTypesModule } from "../ride-types/ride-types.module";
import { AdminCircuitPackagesController } from "./admin-circuit-packages.controller";
import { CircuitPackagesController } from "./circuit-packages.controller";
import { CircuitPackagesService } from "./circuit-packages.service";
import {
  CircuitPackage,
  CircuitPackageCounter,
  CircuitPackageCounterSchema,
  CircuitPackageSchema,
} from "./schemas/circuit-package.schema";

/**
 * Circuit packages: what Admin sells. Depends only on leaf services (places,
 * routes, ride types, audit); CircuitRidesModule depends on this one, never
 * the other way round.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: CircuitPackage.name, schema: CircuitPackageSchema },
      { name: CircuitPackageCounter.name, schema: CircuitPackageCounterSchema },
    ]),
    PlacesModule,
    RideTypesModule,
    LocationsModule,
    AuditModule,
  ],
  controllers: [AdminCircuitPackagesController, CircuitPackagesController],
  providers: [CircuitPackagesService],
  exports: [CircuitPackagesService, MongooseModule],
})
export class CircuitPackagesModule {}
