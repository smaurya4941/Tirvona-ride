import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { ok } from "../../common/http/api-response";
import type { ApiSuccessBody } from "../../common/http/api-response";
import { ParseObjectIdPipe } from "../../common/pipes/parse-object-id.pipe";
import type { AuthenticatedUser } from "../../common/types/jwt-payload";
import { UserRole } from "../../common/types/user-role.enum";
import { CreateRatingDto } from "./dto/rating.dto";
import { RatingsService } from "./ratings.service";
import type { DriverRatingSummary, RatingView, RideRatingStatus } from "./ratings.service";

@ApiTags("Ratings")
@ApiBearerAuth()
@Controller({ path: "rides", version: "1" })
export class RideRatingsController {
  constructor(private readonly ratings: RatingsService) {}

  @Post(":id/rating")
  @Roles(UserRole.CUSTOMER)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: "Rate the driver of a completed, paid ride (once)" })
  async rate(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseObjectIdPipe) id: string,
    @Body() dto: CreateRatingDto,
  ): Promise<ApiSuccessBody<RatingView>> {
    return ok(await this.ratings.rate(user.userId, id, dto));
  }

  @Get(":id/rating")
  @Roles(UserRole.CUSTOMER)
  @ApiOperation({ summary: "The caller's rating of a ride, or whether they can rate it" })
  async status(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseObjectIdPipe) id: string,
  ): Promise<ApiSuccessBody<RideRatingStatus>> {
    return ok(await this.ratings.statusForRide(user.userId, id));
  }
}

@ApiTags("Ratings")
@ApiBearerAuth()
@Controller({ path: "drivers/me/ratings", version: "1" })
export class DriverRatingsController {
  constructor(private readonly ratings: RatingsService) {}

  @Get()
  @Roles(UserRole.DRIVER)
  @ApiOperation({ summary: "The driver's average rating, count and star distribution" })
  async summary(@CurrentUser() user: AuthenticatedUser): Promise<ApiSuccessBody<DriverRatingSummary>> {
    return ok(await this.ratings.summaryForDriverUser(user.userId));
  }
}
