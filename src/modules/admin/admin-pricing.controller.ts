import { Body, Controller, Get, Param, ParseEnumPipe, Patch } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { ok } from "../../common/http/api-response";
import type { ApiSuccessBody } from "../../common/http/api-response";
import type { AuthenticatedUser } from "../../common/types/jwt-payload";
import { UserRole } from "../../common/types/user-role.enum";
import { UpdatePricingDto } from "../pricing/dto/update-pricing.dto";
import { PricingService } from "../pricing/pricing.service";
import type { PricingSummary } from "../pricing/pricing.service";
import { UpdateRideTypeDto } from "../ride-types/dto/update-ride-type.dto";
import { RideTypesService } from "../ride-types/ride-types.service";
import type { RideTypeSummary } from "../ride-types/ride-types.service";
import { RideTypeCode } from "../ride-types/schemas/ride-type.schema";

export interface PricingRow {
  rideType: RideTypeSummary;
  pricing: PricingSummary | null;
}

const rideTypeParam = new ParseEnumPipe(RideTypeCode);

@ApiTags("Admin")
@ApiBearerAuth()
@Roles(UserRole.ADMIN)
@Controller({ path: "admin", version: "1" })
export class AdminPricingController {
  constructor(
    private readonly pricing: PricingService,
    private readonly rideTypes: RideTypesService,
  ) {}

  @Get("pricing")
  @ApiOperation({ summary: "Every ride type with its current tariff" })
  async list(): Promise<ApiSuccessBody<PricingRow[]>> {
    const [rideTypes, configs] = await Promise.all([this.rideTypes.listAll(), this.pricing.listAll()]);
    return ok(
      rideTypes.map((rideType) => {
        const config = configs.find((entry) => entry.rideType === rideType.code);
        return {
          rideType: this.rideTypes.toSummary(rideType),
          pricing: config ? this.pricing.toSummary(config) : null,
        };
      }),
    );
  }

  @Patch("pricing/:rideType")
  @ApiOperation({ summary: "Change a ride type's tariff (applies to new estimates)" })
  async update(
    @Param("rideType", rideTypeParam) rideType: RideTypeCode,
    @Body() dto: UpdatePricingDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<ApiSuccessBody<PricingSummary>> {
    const config = await this.pricing.update(rideType, dto, admin.userId);
    return ok(this.pricing.toSummary(config));
  }

  @Patch("ride-types/:rideType")
  @ApiOperation({ summary: "Enable/disable or rename a ride type" })
  async updateRideType(
    @Param("rideType", rideTypeParam) rideType: RideTypeCode,
    @Body() dto: UpdateRideTypeDto,
  ): Promise<ApiSuccessBody<RideTypeSummary>> {
    const updated = await this.rideTypes.update(rideType, dto);
    return ok(this.rideTypes.toSummary(updated));
  }
}
