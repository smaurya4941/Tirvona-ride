import { Module } from "@nestjs/common";
import type { OnApplicationBootstrap } from "@nestjs/common";
import { Injectable } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { LocationsModule } from "../locations/locations.module";
import { RideTypesModule } from "../ride-types/ride-types.module";
import {
  RideType,
  RideTypeSchema,
} from "../ride-types/schemas/ride-type.schema";
import { PlatformSettingsService } from "./platform-settings.service";
import { RideDistanceConfigService } from "./ride-distance-config.service";
import {
  PlatformSettings,
  PlatformSettingsSchema,
} from "./schemas/platform-settings.schema";
import {
  RideDistanceConfig,
  RideDistanceConfigSchema,
} from "./schemas/ride-distance-config.schema";
import { TripPolicyService } from "./trip-policy.service";

/**
 * Runs after every module's onModuleInit, so the seeded ride types exist
 * before the migration looks for ride types without distance limits.
 */
@Injectable()
export class RideConfigMigration implements OnApplicationBootstrap {
  constructor(
    private readonly distance: RideDistanceConfigService,
    private readonly platform: PlatformSettingsService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.distance.migrateMissing();
    await this.platform.migrateMissing();
  }
}

// Admin-controlled ride configuration (MongoDB is the source of truth):
//   RideConfig → Locations (routes), RideTypes (codes)
// Matching, Rides, Promotions and Admin depend on this module, never the reverse.
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: RideDistanceConfig.name, schema: RideDistanceConfigSchema },
      { name: PlatformSettings.name, schema: PlatformSettingsSchema },
      { name: RideType.name, schema: RideTypeSchema },
    ]),
    LocationsModule,
    RideTypesModule,
  ],
  providers: [
    RideDistanceConfigService,
    PlatformSettingsService,
    TripPolicyService,
    RideConfigMigration,
  ],
  exports: [
    RideDistanceConfigService,
    PlatformSettingsService,
    TripPolicyService,
  ],
})
export class RideConfigModule {}
