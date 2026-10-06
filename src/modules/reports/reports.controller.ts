import { Controller, Get, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Roles } from "../../common/decorators/roles.decorator";
import { ok } from "../../common/http/api-response";
import type { ApiSuccessBody } from "../../common/http/api-response";
import { UserRole } from "../../common/types/user-role.enum";
import { ReportQueryDto } from "./dto/report-query.dto";
import { ReportsService } from "./reports.service";
import type {
  CancellationsReport,
  CustomersReport,
  DriversReport,
  OverviewReport,
  PromotionsReport,
  RevenueReport,
  RidesReport,
} from "./reports.service";

/**
 * Analytics for the admin panel. Ranges are local calendar days in
 * APP_TIME_ZONE: a preset (TODAY, YESTERDAY, LAST_7_DAYS, LAST_30_DAYS) or
 * from/to dates, at most REPORT_MAX_RANGE_DAYS long.
 */
@ApiTags("Admin · Reports")
@ApiBearerAuth()
@Roles(UserRole.ADMIN)
@Controller({ path: "admin/reports", version: "1" })
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get("overview")
  @ApiOperation({
    summary: "Headline rides, customers, drivers and money for the range",
  })
  async overview(
    @Query() query: ReportQueryDto,
  ): Promise<ApiSuccessBody<OverviewReport>> {
    return ok(await this.reports.overview(this.reports.range(query)));
  }

  @Get("rides")
  @ApiOperation({
    summary:
      "Rides requested in the range: outcomes, rates, averages, by ride type / zone / day",
  })
  async rides(
    @Query() query: ReportQueryDto,
  ): Promise<ApiSuccessBody<RidesReport>> {
    return ok(await this.reports.rides(this.reports.range(query)));
  }

  @Get("revenue")
  @ApiOperation({
    summary:
      "Ride value, discounts, collections, refunds, fees, earnings and commission",
  })
  async revenue(
    @Query() query: ReportQueryDto,
  ): Promise<ApiSuccessBody<RevenueReport>> {
    return ok(await this.reports.revenue(this.reports.range(query)));
  }

  @Get("drivers")
  @ApiOperation({
    summary: "Driver pipeline, availability and top drivers in the range",
  })
  async drivers(
    @Query() query: ReportQueryDto,
  ): Promise<ApiSuccessBody<DriversReport>> {
    return ok(await this.reports.drivers(this.reports.range(query)));
  }

  @Get("customers")
  @ApiOperation({
    summary:
      "New / active customers and their bookings (aggregate only, no personal data)",
  })
  async customers(
    @Query() query: ReportQueryDto,
  ): Promise<ApiSuccessBody<CustomersReport>> {
    return ok(await this.reports.customers(this.reports.range(query)));
  }

  @Get("cancellations")
  @ApiOperation({
    summary: "Cancellations by actor, reason, ride state and day; fee totals",
  })
  async cancellations(
    @Query() query: ReportQueryDto,
  ): Promise<ApiSuccessBody<CancellationsReport>> {
    return ok(await this.reports.cancellations(this.reports.range(query)));
  }

  @Get("promotions")
  @ApiOperation({
    summary: "Promo usage, discounts given and promo-assisted rides",
  })
  async promotions(
    @Query() query: ReportQueryDto,
  ): Promise<ApiSuccessBody<PromotionsReport>> {
    return ok(await this.reports.promotions(this.reports.range(query)));
  }
}
