import { Body, Controller, Get, HttpCode, HttpStatus, Post } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { ok } from "../../common/http/api-response";
import type { ApiSuccessBody } from "../../common/http/api-response";
import { ThrottlePolicy } from "../../common/throttle/throttle-policies";
import type { AuthenticatedUser } from "../../common/types/jwt-payload";
import { UserRole } from "../../common/types/user-role.enum";
import { LocationsService } from "../locations/locations.service";
import { PricingService } from "../pricing/pricing.service";
import { RideTypesService } from "../ride-types/ride-types.service";
import { CheckPromoDto, ValidatePromoDto } from "./dto/promo.dto";
import { PromotionsService } from "./promotions.service";
import type { CustomerPromoView } from "./promotions.service";

export interface PromoQuote {
  code: string;
  title: string;
  description?: string;
  rideType: string;
  fare: number;
  discount: number;
  payableFare: number;
  currency: string;
}

@ApiTags("Promotions")
@ApiBearerAuth()
@Roles(UserRole.CUSTOMER)
@Controller({ path: "promotions", version: "1" })
export class PromotionsController {
  constructor(
    private readonly promotions: PromotionsService,
    private readonly rideTypes: RideTypesService,
    private readonly locations: LocationsService,
    private readonly pricing: PricingService,
  ) {}

  @Get()
  @ApiOperation({ summary: "Live offers the app may list (codes flagged 'show in app')" })
  async offers(): Promise<ApiSuccessBody<CustomerPromoView[]>> {
    return ok(await this.promotions.listForCustomers());
  }

  @Post("check")
  @HttpCode(HttpStatus.OK)
  @ThrottlePolicy("promo")
  @ApiOperation({
    summary: "Check a code before a trip is chosen (active, in date, uses left). The fare-based checks run at validate.",
  })
  async check(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CheckPromoDto,
  ): Promise<ApiSuccessBody<CustomerPromoView>> {
    return ok(await this.promotions.check(user.userId, dto.code));
  }

  @Post("validate")
  @HttpCode(HttpStatus.OK)
  @ThrottlePolicy("promo")
  @ApiOperation({
    summary: "Check a promo code for a trip. The server prices the trip; nothing is reserved until booking.",
  })
  async validate(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ValidatePromoDto,
  ): Promise<ApiSuccessBody<PromoQuote>> {
    const rideType = await this.rideTypes.getBookable(dto.rideType);
    const route = await this.locations.estimateTrip(dto.pickup, dto.destination);
    const fare = await this.pricing.priceTrip(rideType.code, route.distanceMeters, route.durationSeconds);
    const { promo, result } = await this.promotions.evaluate(user.userId, dto.code, rideType.code, fare.total);
    if (!result.ok || !promo) throw this.promotions.rejection(result);
    return ok({
      code: promo.code,
      title: promo.title,
      description: promo.description,
      rideType: rideType.code,
      fare: fare.total,
      discount: result.discount,
      payableFare: result.payable,
      currency: fare.currency,
    });
  }
}
