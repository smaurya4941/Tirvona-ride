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
import { AuditLogService } from "../audit/audit-log.service";
import { CommissionService } from "../earnings/commission.service";
import { UpdateCommissionDto } from "../earnings/dto/commission.dto";
import {
  AdminDriverLedgerQueryDto,
  AdminEarningsQueryDto,
  CreatePayoutDto,
  MarkEarningPaidDto,
  PayoutPreviewDto,
  WaiveAdjustmentDto,
} from "../earnings/dto/earnings-query.dto";
import { EarningsAdminService } from "../earnings/earnings-admin.service";
import type { PayoutPreview } from "../earnings/earnings-admin.service";
import type {
  AdjustmentView,
  AdminDriverEarningsDetail,
  AdminDriverEarningsRow,
  AdminEarningsTotals,
  CommissionView,
  Paged,
  PayoutView,
} from "../earnings/interfaces/earning-views";
import { AdminPaymentsQueryDto } from "../payments/dto/payment.dto";
import {
  ReconciliationRunDto,
  ReconciliationRunsQueryDto,
  ResolveExceptionDto,
} from "../payments/dto/reconciliation.dto";
import { AdminRefundsQueryDto, CreateRefundDto, ReviewRefundDto } from "../payments/dto/refund.dto";
import { PaymentEventSource } from "../payments/interfaces/payment-status";
import type {
  AdminPaymentDetail,
  AdminPaymentListItem,
  AdminPaymentsSummary,
  AdminRefundListItem,
  PaymentExceptionsView,
  ReconciliationRunView,
  RefundView,
} from "../payments/interfaces/payment-views";
import { PaymentReconciliationService } from "../payments/payment-reconciliation.service";
import { PaymentsAdminService } from "../payments/payments-admin.service";
import { PaymentsService } from "../payments/payments.service";
import { RefundsService } from "../payments/refunds.service";

@ApiTags("Admin")
@ApiBearerAuth()
@Roles(UserRole.ADMIN)
@Controller({ path: "admin/payments", version: "1" })
export class AdminPaymentsController {
  constructor(
    private readonly payments: PaymentsAdminService,
    private readonly paymentsService: PaymentsService,
    private readonly refunds: RefundsService,
    private readonly reconciliation: PaymentReconciliationService,
    private readonly audit: AuditLogService,
  ) {}

  // Static segments first so Express never reads them as a payment id.

  @Get()
  @ApiOperation({ summary: "Payments with filters (status, date, ride, customer, driver, payment id)" })
  async list(@Query() query: AdminPaymentsQueryDto): Promise<ApiSuccessBody<Paged<AdminPaymentListItem>>> {
    return ok(await this.payments.list(query));
  }

  @Get("summary")
  @ApiOperation({ summary: "Collected today/total, commission, refunds, failures, unpaid completed rides" })
  async summary(): Promise<ApiSuccessBody<AdminPaymentsSummary>> {
    return ok(await this.payments.summary());
  }

  @Get("refunds")
  @ApiOperation({ summary: "Every refund (admin and dashboard), newest first" })
  async refundList(@Query() query: AdminRefundsQueryDto): Promise<ApiSuccessBody<Paged<AdminRefundListItem>>> {
    return ok(await this.refunds.list(query));
  }

  @Post("refunds/:refundId/review")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Decide the driver's share of a refund made in the Razorpay dashboard" })
  async reviewRefund(
    @Param("refundId", ParseObjectIdPipe) refundId: string,
    @Body() dto: ReviewRefundDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<ApiSuccessBody<RefundView>> {
    const refund = await this.refunds.review(admin.userId, refundId, dto);
    await this.audit.record({
      adminId: admin.userId,
      action: "payment.refund_review",
      targetType: "PAYMENT",
      targetId: refund.paymentId,
      targetLabel: refund.rideCode,
      reason: dto.note,
      metadata: { refundId, driverImpact: dto.driverImpact, amount: refund.amount },
    });
    return ok(refund);
  }

  @Get("exceptions")
  @ApiOperation({ summary: "Money needing attention now: duplicates, failed/stuck refunds, flagged webhooks, run exceptions" })
  async exceptions(): Promise<ApiSuccessBody<PaymentExceptionsView>> {
    return ok(await this.reconciliation.exceptions());
  }

  @Get("reconciliation/runs")
  @ApiOperation({ summary: "Razorpay ↔ MongoDB reconciliation runs, newest first" })
  async runs(@Query() query: ReconciliationRunsQueryDto): Promise<ApiSuccessBody<Paged<ReconciliationRunView>>> {
    return ok(await this.reconciliation.listRuns(query.page, query.limit));
  }

  @Post("reconciliation/runs")
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: "Start a reconciliation of a time window (runs in the background; poll the run)" })
  async startRun(
    @Body() dto: ReconciliationRunDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<ApiSuccessBody<ReconciliationRunView>> {
    const run = await this.reconciliation.start(admin.userId, dto);
    await this.audit.record({
      adminId: admin.userId,
      action: "payment.reconciliation_run",
      targetType: "PAYMENT_RECONCILIATION",
      targetId: run.id,
      metadata: { from: dto.from, to: dto.to },
    });
    return ok(run);
  }

  @Get("reconciliation/runs/:runId")
  @ApiOperation({ summary: "One reconciliation run with its exceptions" })
  async run(@Param("runId", ParseObjectIdPipe) runId: string): Promise<ApiSuccessBody<ReconciliationRunView>> {
    return ok(await this.reconciliation.getRun(runId));
  }

  @Post("reconciliation/runs/:runId/exceptions/:exceptionId/resolve")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Mark a reconciliation exception resolved (with a note)" })
  async resolveException(
    @Param("runId", ParseObjectIdPipe) runId: string,
    @Param("exceptionId", ParseObjectIdPipe) exceptionId: string,
    @Body() dto: ResolveExceptionDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<ApiSuccessBody<ReconciliationRunView>> {
    const run = await this.reconciliation.resolveException(runId, exceptionId, admin.userId, dto);
    await this.audit.record({
      adminId: admin.userId,
      action: "payment.reconciliation_resolve",
      targetType: "PAYMENT_RECONCILIATION",
      targetId: runId,
      reason: dto.note,
      metadata: { exceptionId },
    });
    return ok(run);
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
    await this.refunds.syncPayment(payment._id, PaymentEventSource.RECONCILE);
    return ok(await this.payments.detail(id));
  }

  @Post(":id/refunds")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Refund (part of) a captured payment through Razorpay",
    description:
      "Omit amount for a full refund of what remains. idempotencyKey (UUID) makes a retried request safe. " +
      "409 REFUND_NOTHING_LEFT / REFUND_NOT_ALLOWED / REFUND_NOT_SUPPORTED (cash), 400 REFUND_AMOUNT_INVALID, " +
      "502 REFUND_REJECTED when Razorpay refuses.",
  })
  async refund(
    @Param("id", ParseObjectIdPipe) id: string,
    @Body() dto: CreateRefundDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<ApiSuccessBody<RefundView>> {
    let refund: RefundView;
    try {
      refund = await this.refunds.request(admin.userId, id, dto);
    } catch (error) {
      // A refusal from Razorpay is still an admin action worth auditing.
      await this.audit.record({
        adminId: admin.userId,
        action: "payment.refund_failed",
        targetType: "PAYMENT",
        targetId: id,
        reason: dto.note,
        metadata: { amount: dto.amount ?? "FULL", reason: dto.reason, error: (error as Error).message.slice(0, 200) },
      });
      throw error;
    }
    await this.audit.record({
      adminId: admin.userId,
      action: "payment.refund",
      targetType: "PAYMENT",
      targetId: id,
      targetLabel: refund.rideCode,
      reason: dto.note,
      metadata: {
        refundId: refund.id,
        amount: refund.amount,
        reason: refund.reason,
        target: refund.target,
        driverImpact: refund.driverImpact,
        status: refund.status,
      },
    });
    return ok(refund);
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
  constructor(
    private readonly earnings: EarningsAdminService,
    private readonly audit: AuditLogService,
  ) {}

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

  @Post("payouts/preview")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "What a payout of these earnings would transfer after refund deductions" })
  async previewPayout(@Body() dto: PayoutPreviewDto): Promise<ApiSuccessBody<PayoutPreview>> {
    return ok(await this.earnings.previewPayout(dto));
  }

  @Post("adjustments/:id/waive")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Write off an outstanding refund deduction (Tirvona bears it)" })
  async waive(
    @Param("id", ParseObjectIdPipe) id: string,
    @Body() dto: WaiveAdjustmentDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<ApiSuccessBody<AdjustmentView>> {
    const adjustment = await this.earnings.waiveAdjustment(id, dto.note, admin.userId);
    await this.audit.record({
      adminId: admin.userId,
      action: "earnings.adjustment_waive",
      targetType: "DRIVER_EARNING_ADJUSTMENT",
      targetId: id,
      targetLabel: adjustment.rideCode,
      reason: dto.note,
      metadata: { amount: adjustment.amount },
    });
    return ok(adjustment);
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
