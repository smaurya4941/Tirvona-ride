import { Body, Controller, Get, Patch } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { ok } from "../../common/http/api-response";
import type { ApiSuccessBody } from "../../common/http/api-response";
import type { AuthenticatedUser } from "../../common/types/jwt-payload";
import { UserRole } from "../../common/types/user-role.enum";
import { DriverAvailabilityService } from "./driver-availability.service";
import type { DriverDashboard, DriverDutyStatus } from "./driver-availability.service";
import { DriverLocationFixDto } from "../locations/dto/driver-location-fix.dto";
import { UpdateAvailabilityDto } from "./dto/driver-duty.dto";

/**
 * Duty endpoints under /drivers. They live in RidesModule rather than
 * DriversModule because going offline must hand an unanswered request back
 * to dispatch, and DriversModule sits below RidesModule in the graph.
 */
@ApiTags("Drivers")
@ApiBearerAuth()
@Roles(UserRole.DRIVER)
@Controller({ path: "drivers", version: "1" })
export class DriverAvailabilityController {
  constructor(private readonly availability: DriverAvailabilityService) {}

  @Patch("availability")
  @ApiOperation({ summary: "Go online (with location) or offline" })
  async setAvailability(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateAvailabilityDto,
  ): Promise<ApiSuccessBody<DriverDutyStatus>> {
    return ok(await this.availability.setAvailability(user.userId, dto));
  }

  @Patch("location")
  @ApiOperation({ summary: "Location fallback when the socket is down (prefer the driver.location socket message)" })
  async updateLocation(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: DriverLocationFixDto,
  ): Promise<ApiSuccessBody<DriverDutyStatus>> {
    return ok(await this.availability.updateLocation(user.userId, dto));
  }

  @Get("dashboard")
  @ApiOperation({ summary: "Duty status, today's rides and the current ride" })
  async dashboard(@CurrentUser() user: AuthenticatedUser): Promise<ApiSuccessBody<DriverDashboard>> {
    return ok(await this.availability.dashboard(user.userId));
  }
}
