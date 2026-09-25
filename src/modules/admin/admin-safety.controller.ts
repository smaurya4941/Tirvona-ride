import { Body, Controller, Get, Param, Patch, Query } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { ok } from "../../common/http/api-response";
import type { ApiSuccessBody } from "../../common/http/api-response";
import { ParseObjectIdPipe } from "../../common/pipes/parse-object-id.pipe";
import type { AuthenticatedUser } from "../../common/types/jwt-payload";
import { UserRole } from "../../common/types/user-role.enum";
import { startOfDayInTimeZone } from "../../common/utils/time";
import { ComplaintsService } from "../complaints/complaints.service";
import type { AdminComplaintDetail, AdminComplaintView, ComplaintSummary } from "../complaints/complaints.service";
import { AdminListComplaintsQueryDto, UpdateComplaintDto } from "../complaints/dto/complaint.dto";
import type { Page } from "../rides/rides.service";
import { ListSosQueryDto, UpdateSosDto } from "../safety/dto/sos.dto";
import { SosService } from "../safety/sos.service";
import type { AdminSosDetail, AdminSosListItem, SosSummary } from "../safety/sos.service";

@ApiTags("Admin · Safety")
@ApiBearerAuth()
@Roles(UserRole.ADMIN)
@Controller({ path: "admin/sos", version: "1" })
export class AdminSosController {
  constructor(private readonly sos: SosService) {}

  @Get()
  @ApiOperation({ summary: "SOS incidents (filter by status, or open=true)" })
  async list(@Query() query: ListSosQueryDto): Promise<ApiSuccessBody<Page<AdminSosListItem>>> {
    return ok(await this.sos.adminList(query));
  }

  @Get("summary")
  @ApiOperation({ summary: "Active SOS counts (polled by the admin alert banner)" })
  async summary(): Promise<ApiSuccessBody<SosSummary>> {
    return ok(await this.sos.summary());
  }

  @Get(":id")
  @ApiOperation({ summary: "One incident with ride, people, location, contacts and timeline" })
  async detail(@Param("id", ParseObjectIdPipe) id: string): Promise<ApiSuccessBody<AdminSosDetail>> {
    return ok(await this.sos.adminDetail(id));
  }

  @Patch(":id")
  @ApiOperation({ summary: "Acknowledge / mark in progress / resolve / close as false alarm" })
  async update(
    @CurrentUser() admin: AuthenticatedUser,
    @Param("id", ParseObjectIdPipe) id: string,
    @Body() dto: UpdateSosDto,
  ): Promise<ApiSuccessBody<AdminSosDetail>> {
    return ok(await this.sos.adminUpdate(admin.userId, id, dto));
  }
}

@ApiTags("Admin · Complaints")
@ApiBearerAuth()
@Roles(UserRole.ADMIN)
@Controller({ path: "admin/complaints", version: "1" })
export class AdminComplaintsController {
  private readonly timeZone: string;

  constructor(
    private readonly complaints: ComplaintsService,
    config: ConfigService,
  ) {
    this.timeZone = config.getOrThrow<string>("appTimeZone");
  }

  @Get()
  @ApiOperation({ summary: "Complaints (status, category, priority, search)" })
  async list(@Query() query: AdminListComplaintsQueryDto): Promise<ApiSuccessBody<Page<AdminComplaintView>>> {
    return ok(await this.complaints.adminList(query));
  }

  @Get("summary")
  @ApiOperation({ summary: "Open / in review / urgent counts" })
  async summary(): Promise<ApiSuccessBody<ComplaintSummary>> {
    return ok(await this.complaints.summary(startOfDayInTimeZone(new Date(), this.timeZone)));
  }

  @Get(":id")
  @ApiOperation({ summary: "One complaint with user, ride, driver and history" })
  async detail(@Param("id", ParseObjectIdPipe) id: string): Promise<ApiSuccessBody<AdminComplaintDetail>> {
    return ok(await this.complaints.adminDetail(id));
  }

  @Patch(":id")
  @ApiOperation({ summary: "Change status / priority, add a resolution or internal note, assign" })
  async update(
    @CurrentUser() admin: AuthenticatedUser,
    @Param("id", ParseObjectIdPipe) id: string,
    @Body() dto: UpdateComplaintDto,
  ): Promise<ApiSuccessBody<AdminComplaintDetail>> {
    return ok(await this.complaints.adminUpdate(admin.userId, id, dto));
  }
}
