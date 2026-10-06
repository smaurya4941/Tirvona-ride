import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { ok } from "../../common/http/api-response";
import type { ApiSuccessBody } from "../../common/http/api-response";
import { ParseObjectIdPipe } from "../../common/pipes/parse-object-id.pipe";
import type { AuthenticatedUser } from "../../common/types/jwt-payload";
import { UserRole } from "../../common/types/user-role.enum";
import { AdminCancelRideDto } from "../admin/dto/admin-rides.dto";
import { AuditLogService } from "../audit/audit-log.service";
import { RidesAdminService } from "../rides/rides-admin.service";
import type { Page } from "../rides/rides.service";
import { AdminCircuitRidesService } from "./admin-circuit-rides.service";
import type {
  AdminCircuitRideDetail,
  AdminCircuitRideItem,
  CircuitReport,
} from "./admin-circuit-rides.service";
import { CircuitExecutionService } from "./circuit-execution.service";
import {
  AdminListCircuitRidesQueryDto,
  CircuitEligibilityDto,
  CircuitReportQueryDto,
  EndCircuitDto,
  ResolveCircuitExceptionDto,
} from "./dto/circuit-ride.dto";

// Static segments (live, report) come before `:id` so Express never reads them as ids.
@ApiTags("Admin · Circuits")
@ApiBearerAuth()
@Roles(UserRole.ADMIN)
@Controller({ path: "admin/circuit-rides", version: "1" })
export class AdminCircuitRidesController {
  constructor(
    private readonly circuits: AdminCircuitRidesService,
    private readonly execution: CircuitExecutionService,
    private readonly ridesAdmin: RidesAdminService,
    private readonly audit: AuditLogService,
  ) {}

  @Get()
  @ApiOperation({
    summary:
      "Circuit bookings with filters (date, package, city, driver, status, payment status)",
  })
  async list(
    @Query() query: AdminListCircuitRidesQueryDto,
  ): Promise<ApiSuccessBody<Page<AdminCircuitRideItem>>> {
    return ok(await this.circuits.list(query));
  }

  @Get("live")
  @ApiOperation({
    summary:
      "Circuits in progress, with current stop, elapsed time, distance and the driver's position",
  })
  async live(): Promise<ApiSuccessBody<AdminCircuitRideItem[]>> {
    return ok(await this.circuits.live());
  }

  @Get("report")
  @ApiOperation({
    summary:
      "Circuit bookings, revenue, operations and per-package performance",
  })
  async report(
    @Query() query: CircuitReportQueryDto,
  ): Promise<ApiSuccessBody<CircuitReport>> {
    return ok(await this.circuits.report(query));
  }

  @Patch("drivers/:driverId/eligibility")
  @ApiOperation({
    summary: "Allow or stop offering circuit rides to one driver (audited)",
  })
  async setEligibility(
    @Param("driverId", ParseObjectIdPipe) driverId: string,
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: CircuitEligibilityDto,
  ): Promise<
    ApiSuccessBody<{
      driverId: string;
      driverCode: string;
      circuitEligible: boolean;
    }>
  > {
    const result = await this.circuits.setDriverEligibility(
      driverId,
      dto.eligible,
    );
    await this.audit.record({
      adminId: admin.userId,
      action: "driver.circuit_eligibility",
      targetType: "DRIVER",
      targetId: driverId,
      targetLabel: result.driverCode,
      reason: dto.reason,
      metadata: { circuitEligible: dto.eligible },
    });
    return ok(result);
  }

  @Get(":id")
  @ApiOperation({
    summary:
      "One circuit booking: route, usage, financials, status history and the stop-by-stop timeline",
  })
  async detail(
    @Param("id", ParseObjectIdPipe) id: string,
  ): Promise<ApiSuccessBody<AdminCircuitRideDetail>> {
    return ok(await this.circuits.detail(id));
  }

  @Post(":id/exceptions/resolve")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Resolve a blocked stop: let the driver continue, or skip the stop",
  })
  async resolve(
    @Param("id", ParseObjectIdPipe) id: string,
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: ResolveCircuitExceptionDto,
  ): Promise<ApiSuccessBody<AdminCircuitRideDetail>> {
    await this.execution.resolveException(
      admin.userId,
      id,
      dto.resolution,
      dto.note,
    );
    return ok(await this.circuits.detail(id));
  }

  @Post(":id/end")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "End a running circuit that cannot continue; unfinished stops are skipped and the circuit is billed for what it used",
  })
  async end(
    @Param("id", ParseObjectIdPipe) id: string,
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: EndCircuitDto,
  ): Promise<ApiSuccessBody<AdminCircuitRideDetail>> {
    await this.execution.endEarly(admin.userId, id, dto.reason);
    return ok(await this.circuits.detail(id));
  }

  @Post(":id/cancel")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Cancel a circuit that has not started (a started circuit is ended, not cancelled)",
  })
  async cancel(
    @Param("id", ParseObjectIdPipe) id: string,
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: AdminCancelRideDto,
  ): Promise<ApiSuccessBody<AdminCircuitRideDetail>> {
    // Confirms it is a circuit first, then uses the one admin cancellation path.
    await this.circuits.detail(id);
    const detail = await this.ridesAdmin.cancel(
      id,
      admin.userId,
      dto.reason,
      dto.reasonCode,
    );
    await this.audit.record({
      adminId: admin.userId,
      action: "circuit_ride.cancel",
      targetType: "RIDE",
      targetId: id,
      targetLabel: detail.ride.rideCode,
      reason: dto.reason,
      metadata: { reasonCode: dto.reasonCode ?? "OTHER" },
    });
    return ok(await this.circuits.detail(id));
  }
}
