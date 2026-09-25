import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { ok } from "../../common/http/api-response";
import type { ApiSuccessBody } from "../../common/http/api-response";
import { ParseObjectIdPipe } from "../../common/pipes/parse-object-id.pipe";
import type { AuthenticatedUser } from "../../common/types/jwt-payload";
import { UserRole } from "../../common/types/user-role.enum";
import {
  CancelRideDto,
  ListRidesQueryDto,
  RejectRideDto,
  RideRequestDto,
  StartRideDto,
  TripDto,
} from "./dto/ride-requests.dto";
import { RideLifecycleService } from "./ride-lifecycle.service";
import type { CustomerRideView, DriverRideView, RideView } from "./ride-view.service";
import { RidesService } from "./rides.service";
import type { FareEstimateView, Page } from "./rides.service";

type AnyRideView = CustomerRideView | DriverRideView;

// Route order matters: static segments (estimate, active, requests) are
// declared before `:id` so Express never treats them as ride ids.
@ApiTags("Rides")
@ApiBearerAuth()
@Controller({ path: "rides", version: "1" })
export class RidesController {
  constructor(
    private readonly rides: RidesService,
    private readonly lifecycle: RideLifecycleService,
  ) {}

  // ── Customer ──────────────────────────────────────────────────────────

  @Post("estimate")
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.CUSTOMER)
  @ApiOperation({ summary: "Fare estimate for one ride type (server-priced)" })
  async estimate(@Body() dto: RideRequestDto): Promise<ApiSuccessBody<FareEstimateView>> {
    return ok(await this.rides.estimate(dto));
  }

  @Post("estimate/all")
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.CUSTOMER)
  @ApiOperation({ summary: "Fare estimates for every bookable ride type" })
  async estimateAll(@Body() dto: TripDto): Promise<ApiSuccessBody<FareEstimateView[]>> {
    return ok(await this.rides.estimateAll(dto));
  }

  @Post()
  @Roles(UserRole.CUSTOMER)
  @ApiOperation({ summary: "Book a ride; the server re-prices and starts matching" })
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RideRequestDto,
  ): Promise<ApiSuccessBody<CustomerRideView>> {
    return ok(await this.rides.create(user.userId, dto));
  }

  // ── Shared reads ──────────────────────────────────────────────────────

  @Get()
  @Roles(UserRole.CUSTOMER, UserRole.DRIVER)
  @ApiOperation({ summary: "Ride history of the authenticated customer or driver" })
  async history(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListRidesQueryDto,
  ): Promise<ApiSuccessBody<Page<RideView>>> {
    return ok(await this.rides.history(user, query));
  }

  @Get("active")
  @Roles(UserRole.CUSTOMER, UserRole.DRIVER)
  @ApiOperation({ summary: "The caller's in-progress ride, or null" })
  async active(@CurrentUser() user: AuthenticatedUser): Promise<ApiSuccessBody<AnyRideView | null>> {
    return ok(await this.rides.getActive(user));
  }

  @Get("requests")
  @Roles(UserRole.DRIVER)
  @ApiOperation({ summary: "Ride requests assigned to this driver (poll; also a heartbeat)" })
  async requests(@CurrentUser() user: AuthenticatedUser): Promise<ApiSuccessBody<DriverRideView[]>> {
    return ok(await this.rides.requestsForDriver(user.userId));
  }

  @Get(":id")
  @Roles(UserRole.CUSTOMER, UserRole.DRIVER)
  @ApiOperation({ summary: "One ride, as seen by its customer or its driver (poll)" })
  async findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseObjectIdPipe) id: string,
  ): Promise<ApiSuccessBody<AnyRideView>> {
    return ok(await this.rides.getForUser(user, id));
  }

  @Post(":id/cancel")
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.CUSTOMER, UserRole.DRIVER)
  @ApiOperation({ summary: "Cancel a ride (customer: before start; driver: after accept)" })
  async cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseObjectIdPipe) id: string,
    @Body() dto: CancelRideDto,
  ): Promise<ApiSuccessBody<AnyRideView>> {
    return ok(await this.lifecycle.cancel(user, id, dto.reason));
  }

  // ── Driver actions ────────────────────────────────────────────────────

  @Post(":id/accept")
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.DRIVER)
  @ApiOperation({ summary: "Accept an assigned request (atomic; one winner)" })
  async accept(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseObjectIdPipe) id: string,
  ): Promise<ApiSuccessBody<DriverRideView>> {
    return ok(await this.lifecycle.accept(user.userId, id));
  }

  @Post(":id/reject")
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.DRIVER)
  @ApiOperation({ summary: "Reject an assigned request; it is re-matched" })
  async reject(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseObjectIdPipe) id: string,
    @Body() dto: RejectRideDto,
  ): Promise<ApiSuccessBody<{ rejected: true }>> {
    return ok(await this.lifecycle.reject(user.userId, id, dto.reason));
  }

  @Post(":id/arrived")
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.DRIVER)
  @ApiOperation({ summary: "Mark arrival at pickup; issues the customer's OTP" })
  async arrived(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseObjectIdPipe) id: string,
  ): Promise<ApiSuccessBody<DriverRideView>> {
    return ok(await this.lifecycle.arrived(user.userId, id));
  }

  @Post(":id/start")
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.DRIVER)
  @ApiOperation({ summary: "Start the trip with the customer's OTP" })
  async start(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseObjectIdPipe) id: string,
    @Body() dto: StartRideDto,
  ): Promise<ApiSuccessBody<DriverRideView>> {
    return ok(await this.lifecycle.start(user.userId, id, dto.otp));
  }

  @Post(":id/complete")
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.DRIVER)
  @ApiOperation({ summary: "Complete the trip; records the final fare" })
  async complete(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseObjectIdPipe) id: string,
  ): Promise<ApiSuccessBody<DriverRideView>> {
    return ok(await this.lifecycle.complete(user.userId, id));
  }
}
