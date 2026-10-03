import { Controller, Get, Header, Param } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Roles } from "../../common/decorators/roles.decorator";
import { ok } from "../../common/http/api-response";
import type { ApiSuccessBody } from "../../common/http/api-response";
import { ParseObjectIdPipe } from "../../common/pipes/parse-object-id.pipe";
import { UserRole } from "../../common/types/user-role.enum";
import { AdminLiveService } from "./admin-live.service";
import type { LiveDriverView, LiveDriversReport } from "./admin-live.service";

/** Live driver positions for the admin map. Polled by the panel every few seconds. */
@ApiTags("Admin")
@ApiBearerAuth()
@Roles(UserRole.ADMIN)
@Controller({ path: "admin/live", version: "1" })
export class AdminLiveController {
  constructor(private readonly live: AdminLiveService) {}

  @Get("drivers")
  @Header("Cache-Control", "no-store")
  @ApiOperation({ summary: "Every online approved driver with their latest position" })
  async drivers(): Promise<ApiSuccessBody<LiveDriversReport>> {
    return ok(await this.live.onlineDrivers());
  }

  @Get("drivers/:id")
  @Header("Cache-Control", "no-store")
  @ApiOperation({ summary: "One driver's latest position, status and current ride" })
  async driver(@Param("id", ParseObjectIdPipe) id: string): Promise<ApiSuccessBody<LiveDriverView>> {
    return ok(await this.live.driver(id));
  }
}
