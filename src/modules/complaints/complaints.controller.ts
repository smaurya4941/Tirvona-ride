import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { ok } from "../../common/http/api-response";
import type { ApiSuccessBody } from "../../common/http/api-response";
import { ParseObjectIdPipe } from "../../common/pipes/parse-object-id.pipe";
import type { AuthenticatedUser } from "../../common/types/jwt-payload";
import { UserRole } from "../../common/types/user-role.enum";
import type { Page } from "../rides/rides.service";
import { ComplaintsService } from "./complaints.service";
import type { ComplaintView } from "./complaints.service";
import { CreateComplaintDto, ListComplaintsQueryDto } from "./dto/complaint.dto";

@ApiTags("Complaints")
@ApiBearerAuth()
@Roles(UserRole.CUSTOMER, UserRole.DRIVER)
@Controller({ path: "complaints", version: "1" })
export class ComplaintsController {
  constructor(private readonly complaints: ComplaintsService) {}

  @Post()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: "Report an issue (optionally about one of your rides)" })
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateComplaintDto,
  ): Promise<ApiSuccessBody<ComplaintView>> {
    return ok(await this.complaints.create(user, dto));
  }

  @Get()
  @ApiOperation({ summary: "Your complaints, newest first" })
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListComplaintsQueryDto,
  ): Promise<ApiSuccessBody<Page<ComplaintView>>> {
    return ok(await this.complaints.listMine(user, query));
  }

  @Get(":id")
  @ApiOperation({ summary: "One of your complaints with its status and resolution" })
  async findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseObjectIdPipe) id: string,
  ): Promise<ApiSuccessBody<ComplaintView>> {
    return ok(await this.complaints.getMine(user, id));
  }
}
