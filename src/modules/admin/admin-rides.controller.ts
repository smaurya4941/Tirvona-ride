import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { ok } from "../../common/http/api-response";
import type { ApiSuccessBody } from "../../common/http/api-response";
import { ParseObjectIdPipe } from "../../common/pipes/parse-object-id.pipe";
import type { AuthenticatedUser } from "../../common/types/jwt-payload";
import { UserRole } from "../../common/types/user-role.enum";
import { RidesAdminService } from "../rides/rides-admin.service";
import type { AdminRideDetail, AdminRideListItem } from "../rides/rides-admin.service";
import type { Page } from "../rides/rides.service";
import { AdminCancelRideDto, AdminListRidesQueryDto } from "./dto/admin-rides.dto";

@ApiTags("Admin")
@ApiBearerAuth()
@Roles(UserRole.ADMIN)
@Controller({ path: "admin/rides", version: "1" })
export class AdminRidesController {
  constructor(private readonly rides: RidesAdminService) {}

  @Get()
  @ApiOperation({ summary: "List rides with filters and pagination" })
  async list(@Query() query: AdminListRidesQueryDto): Promise<ApiSuccessBody<Page<AdminRideListItem>>> {
    return ok(await this.rides.list(query));
  }

  @Get(":id")
  @ApiOperation({ summary: "Ride detail with customer, driver and status history" })
  async detail(@Param("id", ParseObjectIdPipe) id: string): Promise<ApiSuccessBody<AdminRideDetail>> {
    return ok(await this.rides.detail(id));
  }

  @Post(":id/cancel")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Cancel a ride that has not started (ops)" })
  async cancel(
    @Param("id", ParseObjectIdPipe) id: string,
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: AdminCancelRideDto,
  ): Promise<ApiSuccessBody<AdminRideDetail>> {
    return ok(await this.rides.cancel(id, admin.userId, dto.reason));
  }
}
