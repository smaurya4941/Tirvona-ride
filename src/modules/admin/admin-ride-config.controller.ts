import { Body, Controller, Get, Param, Patch } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { apiBadRequest } from "../../common/exceptions/api.exception";
import { ok } from "../../common/http/api-response";
import type { ApiSuccessBody } from "../../common/http/api-response";
import type { AuthenticatedUser } from "../../common/types/jwt-payload";
import { UserRole } from "../../common/types/user-role.enum";
import { AuditLogService } from "../audit/audit-log.service";
import { distanceLimitsProblem } from "../ride-config/distance-policy";
import { UpdatePlatformSettingsDto, UpdateRideDistanceConfigDto } from "../ride-config/dto/ride-config.dto";
import { PlatformSettingsService } from "../ride-config/platform-settings.service";
import type { PlatformSettingsView } from "../ride-config/platform-settings.service";
import { DISTANCE_LIMITS, RADIUS_LIMITS } from "../ride-config/ride-config.limits";
import { RideDistanceConfigService } from "../ride-config/ride-distance-config.service";
import type { RideDistanceConfigView } from "../ride-config/ride-distance-config.service";
import { RideTypesService } from "../ride-types/ride-types.service";
import type { RideTypeSummary } from "../ride-types/ride-types.service";
import { ParseRideTypeCodePipe } from "./admin-pricing.controller";

export interface RideDistanceConfigRow {
  rideType: RideTypeSummary;
  /** Null until limits are set (new ride types start without any and cannot be activated). */
  config: RideDistanceConfigView | null;
  /** False when a row exists but holds values the runtime refuses (a bad manual edit). */
  usable: boolean;
}

export interface RideDistanceConfigList {
  limits: typeof DISTANCE_LIMITS;
  items: RideDistanceConfigRow[];
}

export interface PlatformSettingsResponse {
  limits: typeof RADIUS_LIMITS;
  settings: PlatformSettingsView | null;
}

const hasChanges = (dto: object): boolean => Object.values(dto).some((value) => value !== undefined);

@ApiTags("Admin · Configuration")
@ApiBearerAuth()
@Roles(UserRole.ADMIN)
@Controller({ path: "admin", version: "1" })
export class AdminRideConfigController {
  constructor(
    private readonly distanceConfigs: RideDistanceConfigService,
    private readonly platform: PlatformSettingsService,
    private readonly rideTypes: RideTypesService,
    private readonly audit: AuditLogService,
  ) {}

  // ── Trip distance limits, per ride type ───────────────────────────────

  @Get("ride-distance-config")
  @ApiOperation({ summary: "Every ride type with its minimum / maximum trip distance" })
  async list(): Promise<ApiSuccessBody<RideDistanceConfigList>> {
    const [rideTypes, configs] = await Promise.all([this.rideTypes.listAll(), this.distanceConfigs.listAll()]);
    const byType = new Map(configs.map((config) => [config.rideType, config]));
    const items = rideTypes.map((rideType): RideDistanceConfigRow => {
      const config = byType.get(rideType.code) ?? null;
      return {
        rideType: this.rideTypes.toSummary(rideType),
        config: config ? this.distanceConfigs.toView(config) : null,
        usable: config !== null && distanceLimitsProblem(config) === null,
      };
    });
    return ok({ limits: DISTANCE_LIMITS, items });
  }

  @Get("ride-distance-config/:rideType")
  @ApiOperation({ summary: "One ride type's trip distance limits" })
  async get(@Param("rideType", ParseRideTypeCodePipe) code: string): Promise<ApiSuccessBody<RideDistanceConfigRow>> {
    return ok(await this.row(code));
  }

  @Patch("ride-distance-config/:rideType")
  @ApiOperation({
    summary:
      "Change a ride type's minimum (metres) and/or maximum (km) trip distance. Applies to the next estimate/booking; booked rides keep the limits they were booked under. Both values are required when the ride type has none yet.",
  })
  async update(
    @Param("rideType", ParseRideTypeCodePipe) code: string,
    @Body() dto: UpdateRideDistanceConfigDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<ApiSuccessBody<RideDistanceConfigRow>> {
    if (!hasChanges(dto)) throw apiBadRequest("Provide a minimum and/or maximum distance", "VALIDATION_FAILED");
    const rideType = await this.rideTypes.getByCode(code);
    const { before, after } = await this.distanceConfigs.save(code, dto, admin.userId);
    await this.audit.record({
      adminId: admin.userId,
      action: before ? "ride_distance_config.update" : "ride_distance_config.create",
      targetType: "RIDE_DISTANCE_CONFIG",
      targetId: code,
      targetLabel: rideType.displayName,
      metadata: {
        version: after.version,
        before: before ? { minDistanceMeters: before.minDistanceMeters, maxDistanceKm: before.maxDistanceKm } : null,
        after: { minDistanceMeters: after.minDistanceMeters, maxDistanceKm: after.maxDistanceKm },
      },
    });
    return ok(await this.row(code));
  }

  // ── Platform ride & matching settings ─────────────────────────────────

  @Get("platform-settings")
  @ApiOperation({ summary: "Matching radius and nearby-drivers radius (global)" })
  async getSettings(): Promise<ApiSuccessBody<PlatformSettingsResponse>> {
    return ok(await this.settingsResponse());
  }

  @Patch("platform-settings")
  @ApiOperation({
    summary: "Change the matching radius and/or the nearby-drivers radius (km). Live on the next search; no restart.",
  })
  async updateSettings(
    @Body() dto: UpdatePlatformSettingsDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<ApiSuccessBody<PlatformSettingsResponse>> {
    if (!hasChanges(dto)) throw apiBadRequest("Provide a matching radius and/or a nearby drivers radius", "VALIDATION_FAILED");
    const { before, after } = await this.platform.update(dto, admin.userId);
    await this.audit.record({
      adminId: admin.userId,
      action: "platform_settings.update",
      targetType: "PLATFORM_SETTINGS",
      targetId: "ride-matching",
      targetLabel: "Ride & matching configuration",
      metadata: {
        version: after.version,
        before: before
          ? { matchingRadiusKm: before.matchingRadiusKm, nearbyDriversRadiusKm: before.nearbyDriversRadiusKm }
          : null,
        after: { matchingRadiusKm: after.matchingRadiusKm, nearbyDriversRadiusKm: after.nearbyDriversRadiusKm },
      },
    });
    return ok(await this.settingsResponse());
  }

  private async row(code: string): Promise<RideDistanceConfigRow> {
    const rideType = await this.rideTypes.getByCode(code);
    const config = await this.distanceConfigs.find(code);
    return {
      rideType: this.rideTypes.toSummary(rideType),
      config: config ? this.distanceConfigs.toView(config) : null,
      usable: config !== null && distanceLimitsProblem(config) === null,
    };
  }

  private async settingsResponse(): Promise<PlatformSettingsResponse> {
    const settings = await this.platform.find();
    return { limits: RADIUS_LIMITS, settings: settings ? this.platform.toView(settings) : null };
  }
}
