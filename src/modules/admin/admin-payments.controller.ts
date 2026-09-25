import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { apiNotFound } from "../../common/exceptions/api.exception";
import { ok } from "../../common/http/api-response";
import type { ApiSuccessBody } from "../../common/http/api-response";
import { ParseObjectIdPipe } from "../../common/pipes/parse-object-id.pipe";
import type { AuthenticatedUser } from "../../common/types/jwt-payload";
import { UserRole } from "../../common/types/user-role.enum";
import { CommissionService } from "../earnings/commission.service";
import { UpdateCommissionDto } from "../earnings/dto/commission.dto";
import {
  AdminDriverLedgerQueryDto,
  AdminEarningsQueryDto,
  CreatePayoutDto,
  MarkEarningPaidDto,
} from "../earnings/dto/earnings-query.dto";
import { EarningsAdminService } from "../earnings/earnings-admin.service";
import type {
  AdminDriverEarningsDetail,
  AdminDriverEarningsRow,
  AdminEarningsTotals,
  CommissionView,
  Paged,
  PayoutView,
} from "../earnings/interfaces/earning-views";
import { AdminPaymentsQueryDto } from "../payments/dto/payment.dto";
import { PaymentEventSource } from "../payments/interfaces/payment-status";
import type {
  AdminPaymentDetail,
  AdminPaymentListItem,
  AdminPaymentsSummary,
} from "../payments/interfaces/payment-views";
import { PaymentsAdminService } from "../payments/payments-admin.service";
import { PaymentsService } from "../payments/payments.service";

@ApiTags("Admin")
@ApiBearerAuth()
@Roles(UserRole.ADMIN)
@Controller({ path: "admin/payments", version: "1" })
export class AdminPaymentsController {
  constructor(
    private readonly payments: PaymentsAdminService,
    private readonly paymentsService: PaymentsService,
  ) {}

  @Get()
  @ApiOperation({ summary: "Payments with filters (status, date, ride, customer, driver, payment id)" })
  async list(@Query() query: AdminPaymentsQueryDto): Promise<ApiSuccessBody<Paged<AdminPaymentListItem>>> {
    return ok(await this.payments.list(query));
  }

  @Get("summary")
  @ApiOperation({ summary: "Collected today/total, commission, failures, unpaid completed rides" })
  async summary(): Promise<ApiSuccessBody<AdminPaymentsSummary>> {
    return ok(await this.payments.summary());
  }

  @Get(":id")
  @ApiOperation({ summary: "Payment detail: Razorpay references, attempts, audit trail, commission split" })
  async detail(@Param("id", ParseObjectIdPipe) id: string): Promise<ApiSuccessBody<AdminPaymentDetail>> {
    return ok(await this.payments.detail(id));
  }

  @Post(":id/reconcile")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Re-check an unfinished payment with Razorpay now" })
  async reconcile(@Param("id", ParseObjectIdPipe) id: string): Promise<ApiSuccessBody<AdminPaymentDetail>> {
    const payment = await this.paymentsService.findById(id);
    if (!payment) throw apiNotFound("Payment not found", "PAYMENT_NOT_FOUND");
    await this.paymentsService.reconcile(payment, PaymentEventSource.RECONCILE);
    return ok(await this.payments.detail(id));
  }
}

@ApiTags("Admin")
@ApiBearerAuth()
@Roles(UserRole.ADMIN)
@Controller({ path: "admin/commission", version: "1" })
export class AdminCommissionController {
  constructor(private readonly commission: CommissionService) {}

  @Get()
  @ApiOperation({ summary: "The commission in force now, plus any scheduled change" })
  async current(): Promise<ApiSuccessBody<{ current: CommissionView; scheduled: CommissionView[] }>> {
    return ok(await this.commission.current());
  }

  @Patch()
  @ApiOperation({ summary: "Set a new commission (a new version; history is kept, past earnings unchanged)" })
  async update(
    @Body() dto: UpdateCommissionDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<ApiSuccessBody<CommissionView>> {
    return ok(await this.commission.update(dto, admin.userId));
  }

  @Get("history")
  @ApiOperation({ summary: "Every commission version, newest first" })
  async history(): Promise<ApiSuccessBody<CommissionView[]>> {
    return ok(await this.commission.history());
  }

  @Post(":id/cancel")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Withdraw a scheduled commission change before it takes effect" })
  async cancel(
    @Param("id", ParseObjectIdPipe) id: string,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<ApiSuccessBody<CommissionView>> {
    return ok(await this.commission.cancelScheduled(id, admin.userId));
  }
}

@ApiTags("Admin")
@ApiBearerAuth()
@Roles(UserRole.ADMIN)
@Controller({ path: "admin/earnings", version: "1" })
export class AdminEarningsController {
  constructor(private readonly earnings: EarningsAdminService) {}

  @Get()
  @ApiOperation({ summary: "Per-driver gross, commission, net, pending, available and paid" })
  async list(@Query() query: AdminEarningsQueryDto): Promise<ApiSuccessBody<Paged<AdminDriverEarningsRow>>> {
    return ok(await this.earnings.listDrivers(query));
  }

  @Get("summary")
  @ApiOperation({ summary: "Platform-wide ledger totals" })
  async totals(): Promise<ApiSuccessBody<AdminEarningsTotals>> {
    return ok(await this.earnings.totals());
  }

  @Post("payouts")
  @ApiOperation({ summary: "Record a manual payout covering selected AVAILABLE earnings of one driver" })
  async payout(
    @Body() dto: CreatePayoutDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<ApiSuccessBody<PayoutView>> {
    return ok(await this.earnings.createPayout(dto, admin.userId));
  }

  @Get(":driverId")
  @ApiOperation({ summary: "One driver's totals, earning ledger and payout history" })
  async driver(
    @Param("driverId", ParseObjectIdPipe) driverId: string,
    @Query() query: AdminDriverLedgerQueryDto,
  ): Promise<ApiSuccessBody<AdminDriverEarningsDetail>> {
    return ok(await this.earnings.driverDetail(driverId, query));
  }

  @Post(":id/mark-paid")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Mark one AVAILABLE earning as paid (manual payout)" })
  async markPaid(
    @Param("id", ParseObjectIdPipe) id: string,
    @Body() dto: MarkEarningPaidDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<ApiSuccessBody<PayoutView>> {
    return ok(await this.earnings.markPaid(id, dto, admin.userId));
  }
}
