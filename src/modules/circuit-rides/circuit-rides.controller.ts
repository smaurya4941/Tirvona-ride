import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { apiNotFound } from "../../common/exceptions/api.exception";
import { ok } from "../../common/http/api-response";
import type { ApiSuccessBody } from "../../common/http/api-response";
import { ParseObjectIdPipe } from "../../common/pipes/parse-object-id.pipe";
import type { AuthenticatedUser } from "../../common/types/jwt-payload";
import { UserRole } from "../../common/types/user-role.enum";
import { RideLifecycleService } from "../rides/ride-lifecycle.service";
import type {
  CustomerRideView,
  DriverRideView,
} from "../rides/ride-view.service";
import { StartRideDto } from "../rides/dto/ride-requests.dto";
import { RidesService } from "../rides/rides.service";
import { CircuitExecutionService } from "./circuit-execution.service";
import { CircuitRidesService } from "./circuit-rides.service";
import type { CircuitEstimateView } from "./circuit-rides.service";
import { RideKind } from "./circuit-ride.types";
import {
  CircuitEstimateDto,
  CreateCircuitRideDto,
  StopNoteDto,
} from "./dto/circuit-ride.dto";

type AnyRideView = CustomerRideView | DriverRideView;

/**
 * Circuit bookings and the driver's circuit commands. A circuit IS a ride, so
 * accept / arrived / start / cancel / payment / rating use the normal ride
 * endpoints (the aliases here exist so the circuit screens have one base path).
 * There is deliberately no PATCH: status, stop, fare and timer only change
 * through these commands, each validated by the server.
 */
@ApiTags("Circuits")
@ApiBearerAuth()
@Controller({ path: "circuit-rides", version: "1" })
export class CircuitRidesController {
  constructor(
    private readonly circuits: CircuitRidesService,
    private readonly execution: CircuitExecutionService,
    private readonly rides: RidesService,
    private readonly lifecycle: RideLifecycleService,
  ) {}

  // ── Customer ──────────────────────────────────────────────────────────

  @Post("estimate")
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.CUSTOMER)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary:
      "Price a circuit from a pickup: route, included usage, extra-charge rules, estimated total",
  })
  async estimate(
    @Body() dto: CircuitEstimateDto,
  ): Promise<ApiSuccessBody<CircuitEstimateView>> {
    return ok(await this.circuits.estimate(dto));
  }

  @Post()
  @Roles(UserRole.CUSTOMER)
  @ApiOperation({
    summary: "Book a circuit; the server re-prices and starts matching",
    description:
      "Send the same Idempotency-Key header (or idempotencyKey) on every retry of one booking to never create two.",
  })
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateCircuitRideDto,
    @Headers("idempotency-key") idempotencyKey?: string,
  ): Promise<ApiSuccessBody<CustomerRideView>> {
    return ok(await this.circuits.create(user.userId, dto, idempotencyKey));
  }

  @Get(":id")
  @Roles(UserRole.CUSTOMER, UserRole.DRIVER)
  @ApiOperation({
    summary:
      "One circuit, as seen by its customer or driver (also the state to reconcile with after a reconnect)",
  })
  async findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseObjectIdPipe) id: string,
  ): Promise<ApiSuccessBody<AnyRideView>> {
    const view = await this.rides.getForUser(user, id);
    if (view.kind !== RideKind.CIRCUIT)
      throw apiNotFound("Circuit not found", "CIRCUIT_NOT_FOUND");
    return ok(view);
  }

  // ── Driver: the ride lifecycle, under the circuit path ────────────────

  @Post(":id/accept")
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.DRIVER)
  @ApiOperation({
    summary:
      "Accept an assigned circuit request (same as POST /rides/:id/accept)",
  })
  async accept(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseObjectIdPipe) id: string,
  ): Promise<ApiSuccessBody<DriverRideView>> {
    return ok(await this.lifecycle.accept(user.userId, id));
  }

  @Post(":id/arrived")
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.DRIVER)
  @ApiOperation({ summary: "Arrived at the pickup; issues the customer's OTP" })
  async arrived(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseObjectIdPipe) id: string,
  ): Promise<ApiSuccessBody<DriverRideView>> {
    return ok(await this.lifecycle.arrived(user.userId, id));
  }

  @Post(":id/start")
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.DRIVER)
  @ApiOperation({
    summary:
      "Start the circuit with the customer's OTP. The included time starts now.",
  })
  async start(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseObjectIdPipe) id: string,
    @Body() dto: StartRideDto,
  ): Promise<ApiSuccessBody<DriverRideView>> {
    return ok(await this.lifecycle.start(user.userId, id, dto.otp));
  }

  // ── Driver: stop progression ──────────────────────────────────────────

  @Post(":id/stops/:order/arrive")
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.DRIVER)
  @ApiOperation({ summary: "Arrived at the current stop (repeat-safe)" })
  async arriveAtStop(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseObjectIdPipe) id: string,
    @Param("order", ParseIntPipe) order: number,
  ): Promise<ApiSuccessBody<DriverRideView>> {
    return ok(await this.execution.arriveAtStop(user.userId, id, order));
  }

  @Post(":id/stops/:order/waiting")
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.DRIVER)
  @ApiOperation({
    summary:
      "The customer is visiting the stop; the driver waits (repeat-safe)",
  })
  async waitAtStop(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseObjectIdPipe) id: string,
    @Param("order", ParseIntPipe) order: number,
  ): Promise<ApiSuccessBody<DriverRideView>> {
    return ok(await this.execution.waitAtStop(user.userId, id, order));
  }

  @Post(":id/stops/:order/complete")
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.DRIVER)
  @ApiOperation({
    summary: "Done at this stop; the next stop becomes current (repeat-safe)",
  })
  async completeStop(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseObjectIdPipe) id: string,
    @Param("order", ParseIntPipe) order: number,
  ): Promise<ApiSuccessBody<DriverRideView>> {
    return ok(await this.execution.completeStop(user.userId, id, order));
  }

  @Post(":id/stops/:order/blocked")
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.DRIVER)
  @ApiOperation({
    summary:
      "Report that the stop cannot be reached or used. Opens an exception only Admin can resolve.",
  })
  async reportBlocked(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseObjectIdPipe) id: string,
    @Param("order", ParseIntPipe) order: number,
    @Body() dto: StopNoteDto,
  ): Promise<ApiSuccessBody<DriverRideView>> {
    return ok(
      await this.execution.reportStopBlocked(user.userId, id, order, dto.note),
    );
  }

  @Post(":id/complete")
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.DRIVER)
  @ApiOperation({
    summary:
      "Complete the circuit after the last stop. The server prices it on what was used and opens the payment.",
  })
  async complete(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseObjectIdPipe) id: string,
  ): Promise<ApiSuccessBody<DriverRideView>> {
    return ok(await this.execution.completeCircuit(user.userId, id));
  }
}
