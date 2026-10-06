import { Injectable, Logger, Module } from "@nestjs/common";
import type { OnApplicationBootstrap } from "@nestjs/common";
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

/** Moves packages saved with a single price onto per-vehicle prices (idempotent). */
@Injectable()
export class CircuitPackagesMigration implements OnApplicationBootstrap {
  private readonly logger = new Logger(CircuitPackagesMigration.name);

  constructor(private readonly packages: CircuitPackagesService) {}

  async onApplicationBootstrap(): Promise<void> {
    const migrated = await this.packages.migrateLegacyPricing();
    if (migrated) this.logger.log(`Moved ${migrated} circuit package(s) onto per-vehicle pricing`);
  }
}

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
  providers: [CircuitPackagesService, CircuitPackagesMigration],
  exports: [CircuitPackagesService, MongooseModule],
})
export class CircuitPackagesModule {}
