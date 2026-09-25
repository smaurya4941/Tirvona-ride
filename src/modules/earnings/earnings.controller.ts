import { Controller, Get, Param, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { ok } from "../../common/http/api-response";
import type { ApiSuccessBody } from "../../common/http/api-response";
import { ParseObjectIdPipe } from "../../common/pipes/parse-object-id.pipe";
import type { AuthenticatedUser } from "../../common/types/jwt-payload";
import { UserRole } from "../../common/types/user-role.enum";
import { DriverEarningsQueryDto } from "./dto/earnings-query.dto";
import { EarningsService } from "./earnings.service";
import type { DriverEarningsResponse, EarningView } from "./interfaces/earning-views";

@ApiTags("Earnings")
@ApiBearerAuth()
@Roles(UserRole.DRIVER)
@Controller({ path: "earnings", version: "1" })
export class EarningsController {
  constructor(private readonly earnings: EarningsService) {}

  @Get()
  @ApiOperation({
    summary: "The driver's earnings: today/week/month/total, pending/available/paid balances, and the ledger",
  })
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: DriverEarningsQueryDto,
  ): Promise<ApiSuccessBody<DriverEarningsResponse>> {
    return ok(await this.earnings.forDriver(user.userId, query));
  }

  @Get(":id")
  @ApiOperation({ summary: "One earning: gross fare, commission, net, status, payout" })
  async detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseObjectIdPipe) id: string,
  ): Promise<ApiSuccessBody<EarningView>> {
    return ok(await this.earnings.detailForDriver(user.userId, id));
  }
}
