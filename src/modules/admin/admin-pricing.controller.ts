import { Body, Controller, Get, Injectable, Param, Patch, Post } from "@nestjs/common";
import type { PipeTransform } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { apiBadRequest, apiConflict } from "../../common/exceptions/api.exception";
import { ok } from "../../common/http/api-response";
import type { ApiSuccessBody } from "../../common/http/api-response";
import type { AuthenticatedUser } from "../../common/types/jwt-payload";
import { UserRole } from "../../common/types/user-role.enum";
import { AuditLogService } from "../audit/audit-log.service";
import { UpdatePricingDto } from "../pricing/dto/update-pricing.dto";
import { PricingService } from "../pricing/pricing.service";
import type { PricingSummary } from "../pricing/pricing.service";
import { CreateRideTypeDto, UpdateRideTypeDto } from "../ride-types/dto/update-ride-type.dto";
import { RideTypesService } from "../ride-types/ride-types.service";
import type { RideTypeSummary } from "../ride-types/ride-types.service";
import { RIDE_TYPE_CODE_PATTERN } from "../ride-types/schemas/ride-type.schema";

export interface PricingRow {
  rideType: RideTypeSummary;
  pricing: PricingSummary | null;
}

@Injectable()
export class ParseRideTypeCodePipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (typeof value !== "string" || !RIDE_TYPE_CODE_PATTERN.test(value))
      throw apiBadRequest("Invalid ride type code", "VALIDATION_FAILED");
    return value;
  }
}

const RATE_FIELDS = ["baseFare", "perKmRate", "perMinuteRate", "minimumFare"] as const;

@ApiTags("Admin · Configuration")
@ApiBearerAuth()
@Roles(UserRole.ADMIN)
@Controller({ path: "admin", version: "1" })
export class AdminPricingController {
  constructor(
    private readonly pricing: PricingService,
    private readonly rideTypes: RideTypesService,
    private readonly audit: AuditLogService,
  ) {}

  // ── Pricing ───────────────────────────────────────────────────────────

  @Get("pricing")
  @ApiOperation({ summary: "Every ride type with its current tariff" })
  async list(): Promise<ApiSuccessBody<PricingRow[]>> {
    return ok(await this.rows());
  }

  @Patch("pricing/:rideType")
  @ApiOperation({
    summary: "Change a ride type's tariff (new estimates only; booked rides keep theirs). Creates the first tariff when all four rates are given.",
  })
  async update(
    @Param("rideType", ParseRideTypeCodePipe) rideType: string,
    @Body() dto: UpdatePricingDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<ApiSuccessBody<PricingSummary>> {
    await this.rideTypes.getByCode(rideType);
    const existing = await this.pricing.findConfig(rideType);
    let config;
    if (existing) {
      config = await this.pricing.update(rideType, dto, admin.userId);
    } else {
      if (RATE_FIELDS.some((field) => dto[field] === undefined))
        throw apiBadRequest(
          "This ride type has no tariff yet: provide base fare, per km, per minute and minimum fare",
          "PRICING_NOT_CONFIGURED",
        );
      config = await this.pricing.create(rideType, dto as Required<UpdatePricingDto>, admin.userId);
    }
    await this.audit.record({
      adminId: admin.userId,
      action: existing ? "pricing.update" : "pricing.create",
      targetType: "PRICING",
      targetId: rideType,
      targetLabel: rideType,
      metadata: { version: config.version, changes: { ...dto } },
    });
    return ok(this.pricing.toSummary(config));
  }

  // ── Ride types ────────────────────────────────────────────────────────

  @Get("ride-types")
  @ApiOperation({ summary: "All ride types, active and inactive, with their tariff" })
  async listRideTypes(): Promise<ApiSuccessBody<PricingRow[]>> {
    return ok(await this.rows());
  }

  @Post("ride-types")
  @ApiOperation({ summary: "Create a ride type (optionally with its first tariff). Active requires a tariff." })
  async createRideType(
    @Body() dto: CreateRideTypeDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<ApiSuccessBody<PricingRow>> {
    if (dto.isActive && !dto.pricing)
      throw apiBadRequest("Set a tariff to create the ride type as active", "RIDE_TYPE_PRICING_REQUIRED");
    if ((await this.rideTypes.findByCode(dto.code)) || (await this.pricing.findConfig(dto.code)))
      throw apiConflict(`A ride type with code ${dto.code} already exists`, "RIDE_TYPE_ALREADY_EXISTS");

    const { pricing: tariff, ...fields } = dto;
    const rideType = await this.rideTypes.create(fields);
    const config = tariff ? await this.pricing.create(rideType.code, tariff, admin.userId) : null;
    await this.audit.record({
      adminId: admin.userId,
      action: "ride_type.create",
      targetType: "RIDE_TYPE",
      targetId: rideType.code,
      targetLabel: rideType.displayName,
      metadata: { vehicleType: rideType.vehicleType, isActive: rideType.isActive, tariff: tariff ? { ...tariff } : null },
    });
    return ok({
      rideType: this.rideTypes.toSummary(rideType),
      pricing: config ? this.pricing.toSummary(config) : null,
    });
  }

  @Patch("ride-types/:rideType")
  @ApiOperation({ summary: "Edit, activate or deactivate a ride type (never deleted; history stays readable)" })
  async updateRideType(
    @Param("rideType", ParseRideTypeCodePipe) code: string,
    @Body() dto: UpdateRideTypeDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<ApiSuccessBody<RideTypeSummary>> {
    const before = await this.rideTypes.getByCode(code);
    if (dto.isActive === true && !before.isActive && !(await this.pricing.findConfig(code)))
      throw apiBadRequest(
        `Set a tariff for ${before.displayName} before making it bookable`,
        "RIDE_TYPE_PRICING_REQUIRED",
      );

    const { reason, ...changes } = dto;
    const updated = await this.rideTypes.update(code, changes);
    const toggled = dto.isActive !== undefined && dto.isActive !== before.isActive;
    await this.audit.record({
      adminId: admin.userId,
      action: toggled ? (updated.isActive ? "ride_type.activate" : "ride_type.deactivate") : "ride_type.update",
      targetType: "RIDE_TYPE",
      targetId: code,
      targetLabel: updated.displayName,
      reason,
      metadata: { changes: { ...changes } },
    });
    return ok(this.rideTypes.toSummary(updated));
  }

  private async rows(): Promise<PricingRow[]> {
    const [rideTypes, configs] = await Promise.all([this.rideTypes.listAll(), this.pricing.listAll()]);
    return rideTypes.map((rideType) => {
      const config = configs.find((entry) => entry.rideType === rideType.code);
      return {
        rideType: this.rideTypes.toSummary(rideType),
        pricing: config ? this.pricing.toSummary(config) : null,
      };
    });
  }
}
