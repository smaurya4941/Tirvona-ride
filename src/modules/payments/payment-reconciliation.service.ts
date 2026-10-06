import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectModel } from "@nestjs/mongoose";
import type { Model } from "mongoose";
import { Types } from "mongoose";
import {
  ApiException,
  apiBadRequest,
  apiNotFound,
} from "../../common/exceptions/api.exception";
import { toRupees } from "../../common/utils/money";
import { startOfDayInTimeZone } from "../../common/utils/time";
import type {
  ReconciliationRunDto,
  ResolveExceptionDto,
} from "./dto/reconciliation.dto";
import {
  OPEN_PAYMENT_STATUSES,
  PAYMENT_APP_TAG,
  PaymentEventSource,
  PaymentGateway,
  PaymentStatus,
  SETTLED_PAYMENT_STATUSES,
} from "./interfaces/payment-status";
import {
  PaymentRefundState,
  RefundLedgerState,
  RefundStatus,
} from "./interfaces/refund-status";
import type {
  PaymentExceptionItem,
  PaymentExceptionsView,
  ReconciliationRunView,
} from "./interfaces/payment-views";
import { PaymentsService } from "./payments.service";
import { RazorpayGateway } from "./razorpay/razorpay.gateway";
import type { RazorpayPayment } from "./razorpay/razorpay.types";
import { RefundsService } from "./refunds.service";
import { Payment } from "./schemas/payment.schema";
import type { PaymentDocument } from "./schemas/payment.schema";
import {
  PaymentReconciliationRun,
  ReconciliationExceptionType,
  ReconciliationRunStatus,
  ReconciliationSeverity,
  ReconciliationTrigger,
} from "./schemas/payment-reconciliation-run.schema";
import type {
  PaymentReconciliationRunDocument,
  ReconciliationException,
  ReconciliationStats,
} from "./schemas/payment-reconciliation-run.schema";
import { PaymentRefund } from "./schemas/payment-refund.schema";
import {
  PaymentWebhookEvent,
  WebhookEventStatus,
} from "./schemas/payment-webhook-event.schema";

const PAGE_SIZE = 100;
/** 50 pages × 100 = 5,000 Razorpay payments per run; more marks the run truncated. */
const MAX_PAGES = 50;
const MAX_STORED_EXCEPTIONS = 500;
const MAX_INDIVIDUAL_FETCHES = 200;
/** A RUNNING run older than this crashed with its instance; another may start. */
const RUN_STALE_MS = 30 * 60_000;
const DAY_MS = 86_400_000;
const AUTHORIZED_GRACE_S = 3600;
const EXCEPTION_WINDOW_MS = 30 * DAY_MS;

type NewException = Omit<ReconciliationException, "_id">;

const noteOf = (
  notes: RazorpayPayment["notes"],
  key: string,
): string | undefined =>
  notes && !Array.isArray(notes) && typeof notes[key] === "string"
    ? notes[key]
    : undefined;
const describe = (status: string, paise: number) =>
  `${status} ₹${toRupees(paise)}`;

/**
 * Razorpay ↔ MongoDB reconciliation. Complements the minute-by-minute
 * PaymentsReconciler (which fixes payments it already suspects) with a
 * sweep that trusts nothing: every Razorpay payment of the window is
 * compared with our records and vice versa.
 *
 * Healing always goes through the normal settlement paths
 * (applyGatewayPayment / RefundsService.syncPayment), so a run can never
 * create money our own rules would not.
 */
@Injectable()
export class PaymentReconciliationService {
  private readonly logger = new Logger(PaymentReconciliationService.name);
  private readonly timeZone: string;
  private readonly maxRangeMs: number;
  private readonly dailyEnabled: boolean;
  private readonly dailyHour: number;

  constructor(
    @InjectModel(Payment.name) private readonly paymentModel: Model<Payment>,
    @InjectModel(PaymentRefund.name)
    private readonly refundModel: Model<PaymentRefund>,
    @InjectModel(PaymentReconciliationRun.name)
    private readonly runModel: Model<PaymentReconciliationRun>,
    @InjectModel(PaymentWebhookEvent.name)
    private readonly webhookModel: Model<PaymentWebhookEvent>,
    private readonly gateway: RazorpayGateway,
    private readonly payments: PaymentsService,
    private readonly refunds: RefundsService,
    config: ConfigService,
  ) {
    this.timeZone = config.getOrThrow<string>("appTimeZone");
    this.maxRangeMs =
      config.getOrThrow<number>("paymentReconciliationMaxDays") * DAY_MS;
    this.dailyEnabled = config.getOrThrow<boolean>(
      "paymentDailyReconciliation",
    );
    this.dailyHour = config.getOrThrow<number>(
      "paymentDailyReconciliationHour",
    );
  }

  // ── Runs ──────────────────────────────────────────────────────────────

  /** Starts an admin run in the background; poll the returned run. */
  async start(
    adminUserId: string,
    dto: ReconciliationRunDto,
  ): Promise<ReconciliationRunView> {
    if (!this.gateway.isConfigured)
      throw new ApiException(
        HttpStatus.SERVICE_UNAVAILABLE,
        "Razorpay is not configured",
        "PAYMENT_GATEWAY_NOT_CONFIGURED",
      );
    const from = new Date(dto.from);
    const to = dto.to ? new Date(dto.to) : new Date();
    if (
      Number.isNaN(from.getTime()) ||
      Number.isNaN(to.getTime()) ||
      from >= to
    )
      throw apiBadRequest("'from' must be before 'to'", "VALIDATION_FAILED");
    if (to.getTime() - from.getTime() > this.maxRangeMs)
      throw apiBadRequest(
        `A run covers at most ${Math.round(this.maxRangeMs / DAY_MS)} days`,
        "VALIDATION_FAILED",
      );
    if (to.getTime() > Date.now() + 60_000)
      throw apiBadRequest("'to' cannot be in the future", "VALIDATION_FAILED");

    const running = await this.runModel
      .exists({
        status: ReconciliationRunStatus.RUNNING,
        startedAt: { $gt: new Date(Date.now() - RUN_STALE_MS) },
      })
      .exec();
    if (running)
      throw new ApiException(
        HttpStatus.CONFLICT,
        "A reconciliation run is already in progress",
        "RECONCILIATION_RUNNING",
      );

    const id = new Types.ObjectId();
    const run = await this.runModel.create({
      _id: id,
      key: `admin:${id.toString()}`,
      trigger: ReconciliationTrigger.ADMIN,
      from,
      to,
      status: ReconciliationRunStatus.RUNNING,
      startedBy: new Types.ObjectId(adminUserId),
      startedAt: new Date(),
    });
    void this.execute(run);
    return this.toRunView(run, false);
  }

  /**
   * Yesterday's automatic run, once the configured local hour has passed.
   * The unique `key` makes this exactly-once across instances and restarts.
   */
  async ensureDailyRun(now = new Date()): Promise<boolean> {
    if (!this.dailyEnabled || !this.gateway.isConfigured) return false;
    const today = startOfDayInTimeZone(now, this.timeZone);
    if (now.getTime() < today.getTime() + this.dailyHour * 3_600_000)
      return false;
    const yesterday = startOfDayInTimeZone(
      new Date(today.getTime() - DAY_MS / 2),
      this.timeZone,
    );
    const key = `daily:${new Intl.DateTimeFormat("en-CA", { timeZone: this.timeZone }).format(yesterday)}`;
    if (await this.runModel.exists({ key }).exec()) return false;
    let run: PaymentReconciliationRunDocument;
    try {
      run = await this.runModel.create({
        key,
        trigger: ReconciliationTrigger.DAILY,
        from: yesterday,
        to: today,
        status: ReconciliationRunStatus.RUNNING,
        startedAt: new Date(),
      });
    } catch (error) {
      if ((error as { code?: number }).code === 11000) return false;
      throw error;
    }
    void this.execute(run);
    return true;
  }

  /** The comparison itself. Public so tests can await it. */
  async execute(
    run: PaymentReconciliationRunDocument,
  ): Promise<PaymentReconciliationRunDocument> {
    const stats: ReconciliationStats = {
      gatewayPayments: 0,
      ridePayments: 0,
      foreignPayments: 0,
      matched: 0,
      recordedChecked: 0,
      exceptions: 0,
      healed: 0,
      gatewayCapturedPaise: 0,
      recordedCapturedPaise: 0,
    };
    const exceptions: NewException[] = [];
    let truncated = false;
    const add = (exception: NewException) => {
      stats.exceptions += 1;
      if (exception.healed) stats.healed += 1;
      if (exceptions.length < MAX_STORED_EXCEPTIONS) exceptions.push(exception);
      else truncated = true;
    };

    try {
      // 1. Razorpay → us.
      const seenCaptured = new Set<string>();
      for (let page = 0; ; page += 1) {
        if (page >= MAX_PAGES) {
          truncated = true;
          break;
        }
        const items = await this.gateway.listPayments({
          from: Math.floor(run.from.getTime() / 1000),
          to: Math.floor(run.to.getTime() / 1000),
          count: PAGE_SIZE,
          skip: page * PAGE_SIZE,
        });
        stats.gatewayPayments += items.length;
        const orderIds = items
          .map((item) => item.order_id)
          .filter((id): id is string => Boolean(id));
        const ours = orderIds.length
          ? await this.paymentModel
              .find({ "attempts.orderId": { $in: orderIds } })
              .exec()
          : [];
        const byOrder = new Map<string, PaymentDocument>();
        for (const payment of ours)
          for (const attempt of payment.attempts)
            byOrder.set(attempt.orderId, payment);

        for (const item of items) {
          const payment = item.order_id
            ? byOrder.get(item.order_id)
            : undefined;
          if (!payment) {
            if (noteOf(item.notes, "app") === PAYMENT_APP_TAG)
              add({
                type: ReconciliationExceptionType.UNKNOWN_ORDER,
                severity: ReconciliationSeverity.WARNING,
                razorpayPaymentId: item.id,
                razorpayOrderId: item.order_id ?? undefined,
                actual: describe(item.status, item.amount),
                detail:
                  "Razorpay payment tagged for Tirvona Ride whose order is not in our records",
                healed: false,
              });
            else stats.foreignPayments += 1;
            continue;
          }
          stats.ridePayments += 1;
          if (item.status === "captured" || item.status === "refunded") {
            stats.gatewayCapturedPaise += item.amount;
            seenCaptured.add(item.id);
          }
          await this.compare(payment, item, add, stats);
        }
        if (items.length < PAGE_SIZE) break;
      }

      // 2. Us → Razorpay: every online payment we call paid in the window.
      const recorded = await this.paymentModel
        .find({
          gateway: PaymentGateway.RAZORPAY,
          status: { $in: SETTLED_PAYMENT_STATUSES },
          paidAt: { $gte: run.from, $lt: run.to },
        })
        .exec();
      let fetched = 0;
      for (const payment of recorded) {
        stats.recordedChecked += 1;
        stats.recordedCapturedPaise += payment.amountPaise;
        if (
          !payment.razorpayPaymentId ||
          seenCaptured.has(payment.razorpayPaymentId)
        )
          continue;
        // Created before the window (captured later) or beyond the page cap: ask directly.
        if (fetched >= MAX_INDIVIDUAL_FETCHES) {
          truncated = true;
          continue;
        }
        fetched += 1;
        let gatewayPayment: RazorpayPayment | undefined;
        try {
          gatewayPayment = await this.gateway.fetchPayment(
            payment.razorpayPaymentId,
          );
        } catch (error) {
          this.logger.warn(
            `Run ${run.key}: could not fetch ${payment.razorpayPaymentId}: ${(error as Error).message}`,
          );
        }
        if (
          !gatewayPayment ||
          (gatewayPayment.status !== "captured" &&
            gatewayPayment.status !== "refunded")
        )
          add({
            type: ReconciliationExceptionType.RECORDED_PAID_NOT_AT_GATEWAY,
            severity: ReconciliationSeverity.CRITICAL,
            paymentId: payment._id,
            rideCode: payment.rideCode,
            razorpayPaymentId: payment.razorpayPaymentId,
            expected: describe(payment.status, payment.amountPaise),
            actual: gatewayPayment
              ? describe(gatewayPayment.status, gatewayPayment.amount)
              : "not found",
            detail:
              "We recorded this payment as paid but Razorpay does not show it captured",
            healed: false,
          });
        else if (gatewayPayment.amount !== payment.amountPaise)
          add({
            type: ReconciliationExceptionType.AMOUNT_MISMATCH,
            severity: ReconciliationSeverity.CRITICAL,
            paymentId: payment._id,
            rideCode: payment.rideCode,
            razorpayPaymentId: payment.razorpayPaymentId,
            expected: describe(payment.status, payment.amountPaise),
            actual: describe(gatewayPayment.status, gatewayPayment.amount),
            detail: "Captured amount differs from the ride's bill",
            healed: false,
          });
        else stats.matched += 1;
      }

      run.status = ReconciliationRunStatus.COMPLETED;
    } catch (error) {
      run.status = ReconciliationRunStatus.FAILED;
      run.error = (error as Error).message.slice(0, 500);
      this.logger.error(
        `Reconciliation run ${run.key} failed`,
        error instanceof Error ? error.stack : String(error),
      );
    }

    run.stats = stats;
    run.exceptions = exceptions as ReconciliationException[];
    run.truncated = truncated;
    run.finishedAt = new Date();
    await run.save();
    const unhealed = stats.exceptions - stats.healed;
    if (unhealed)
      this.logger.error(
        `Reconciliation ${run.key}: ${unhealed} exception(s) need attention`,
      );
    else
      this.logger.log(
        `Reconciliation ${run.key}: ${stats.ridePayments} Ride payments, ${stats.healed} healed, clean`,
      );
    return run;
  }

  /** One Razorpay payment of ours against our record; heals what it safely can. */
  private async compare(
    payment: PaymentDocument,
    item: RazorpayPayment,
    add: (exception: NewException) => void,
    stats: ReconciliationStats,
  ): Promise<void> {
    const base = {
      paymentId: payment._id,
      rideCode: payment.rideCode,
      razorpayPaymentId: item.id,
      razorpayOrderId: item.order_id ?? undefined,
      actual: describe(item.status, item.amount),
    };
    const captured = item.status === "captured" || item.status === "refunded";

    if (
      item.amount !== payment.amountPaise &&
      (captured || item.status === "authorized")
    ) {
      add({
        ...base,
        type: ReconciliationExceptionType.AMOUNT_MISMATCH,
        severity: ReconciliationSeverity.CRITICAL,
        expected: describe(payment.status, payment.amountPaise),
        detail:
          "Razorpay's amount differs from the ride's bill; never marked paid",
        healed: false,
      });
      return;
    }

    if (captured && payment.razorpayPaymentId === item.id) {
      stats.matched += 1;
      const ourRefunded = await this.gatewayVisibleRefunds(
        payment._id,
        item.id,
      );
      if ((item.amount_refunded ?? 0) !== ourRefunded) {
        await this.refunds.syncPayment(
          payment._id,
          PaymentEventSource.RECONCILE,
        );
        const after = await this.gatewayVisibleRefunds(payment._id, item.id);
        add({
          ...base,
          type: ReconciliationExceptionType.REFUND_MISMATCH,
          severity:
            after === (item.amount_refunded ?? 0)
              ? ReconciliationSeverity.INFO
              : ReconciliationSeverity.WARNING,
          expected: `refunded ₹${toRupees(ourRefunded)}`,
          actual: `refunded ₹${toRupees(item.amount_refunded ?? 0)}`,
          detail:
            after === (item.amount_refunded ?? 0)
              ? "Refunds re-synced from Razorpay"
              : "Refund totals still differ after re-sync (a refund may be in flight)",
          healed: after === (item.amount_refunded ?? 0),
        });
      }
      return;
    }

    if (captured && SETTLED_PAYMENT_STATUSES.includes(payment.status)) {
      if (
        payment.duplicateCaptures.some(
          (duplicate) => duplicate.razorpayPaymentId === item.id,
        )
      )
        return;
      await this.safeApply(payment, item);
      const after = await this.paymentModel.findById(payment._id).exec();
      add({
        ...base,
        type: ReconciliationExceptionType.UNTRACKED_DUPLICATE,
        severity: ReconciliationSeverity.WARNING,
        expected: `paid by ${payment.razorpayPaymentId ?? "cash"}`,
        detail:
          "A second capture on an already-paid ride — refund it from the payment page",
        healed: Boolean(
          after?.duplicateCaptures.some(
            (duplicate) => duplicate.razorpayPaymentId === item.id,
          ),
        ),
      });
      return;
    }

    if (captured && OPEN_PAYMENT_STATUSES.includes(payment.status)) {
      const after = await this.safeApply(payment, item);
      add({
        ...base,
        type: ReconciliationExceptionType.GATEWAY_PAID_NOT_RECORDED,
        severity:
          after && SETTLED_PAYMENT_STATUSES.includes(after.status)
            ? ReconciliationSeverity.WARNING
            : ReconciliationSeverity.CRITICAL,
        expected: describe(payment.status, payment.amountPaise),
        detail:
          after && SETTLED_PAYMENT_STATUSES.includes(after.status)
            ? "Razorpay had captured this payment; now recorded as paid (ride and earning updated)"
            : "Razorpay captured money we have not recorded — check the payment",
        healed: Boolean(
          after && SETTLED_PAYMENT_STATUSES.includes(after.status),
        ),
      });
      return;
    }

    if (
      item.status === "authorized" &&
      Date.now() / 1000 - item.created_at > AUTHORIZED_GRACE_S
    ) {
      const after = OPEN_PAYMENT_STATUSES.includes(payment.status)
        ? await this.safeApply(payment, item)
        : null;
      const settled = Boolean(
        after &&
        after.status === PaymentStatus.CAPTURED &&
        after.razorpayPaymentId === item.id,
      );
      add({
        ...base,
        type: ReconciliationExceptionType.AUTHORIZED_NOT_CAPTURED,
        severity: ReconciliationSeverity.INFO,
        expected: describe(payment.status, payment.amountPaise),
        detail: settled
          ? "Authorised payment captured for the ride"
          : "Authorised but not captured — Razorpay refunds it to the customer automatically",
        healed: settled,
      });
    }
  }

  private async safeApply(
    payment: PaymentDocument,
    item: RazorpayPayment,
  ): Promise<PaymentDocument | null> {
    try {
      return await this.payments.applyGatewayPayment(
        payment,
        item,
        PaymentEventSource.RECONCILE,
      );
    } catch (error) {
      this.logger.warn(
        `Reconciliation could not apply ${item.id} to ${payment._id.toString()}: ${(error as Error).message}`,
      );
      return this.paymentModel.findById(payment._id).exec();
    }
  }

  /** What Razorpay counts in amount_refunded: refunds it accepted (pending or processed). */
  private async gatewayVisibleRefunds(
    paymentId: Types.ObjectId,
    razorpayPaymentId: string,
  ): Promise<number> {
    const [row] = await this.refundModel
      .aggregate<{ total: number }>([
        {
          $match: {
            paymentId,
            razorpayPaymentId,
            status: { $in: [RefundStatus.PENDING, RefundStatus.PROCESSED] },
          },
        },
        { $group: { _id: null, total: { $sum: "$amountPaise" } } },
      ])
      .exec();
    return row?.total ?? 0;
  }

  // ── Admin reads ───────────────────────────────────────────────────────

  async listRuns(
    page: number,
    limit: number,
  ): Promise<{
    items: ReconciliationRunView[];
    page: number;
    limit: number;
    total: number;
    hasMore: boolean;
  }> {
    const [runs, total] = await Promise.all([
      this.runModel
        .find()
        .sort({ startedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
      this.runModel.countDocuments().exec(),
    ]);
    return {
      items: runs.map((run) => this.toRunView(run, false)),
      page,
      limit,
      total,
      hasMore: page * limit < total,
    };
  }

  async getRun(runId: string): Promise<ReconciliationRunView> {
    const run = await this.runModel.findById(runId).exec();
    if (!run)
      throw apiNotFound(
        "Reconciliation run not found",
        "RECONCILIATION_RUN_NOT_FOUND",
      );
    return this.toRunView(run, true);
  }

  async resolveException(
    runId: string,
    exceptionId: string,
    adminUserId: string,
    dto: ResolveExceptionDto,
  ): Promise<ReconciliationRunView> {
    // Resolving twice keeps the first resolution (the array filter skips it).
    const run = await this.runModel
      .findOneAndUpdate(
        { _id: new Types.ObjectId(runId) },
        {
          $set: {
            "exceptions.$[target].resolvedAt": new Date(),
            "exceptions.$[target].resolvedBy": new Types.ObjectId(adminUserId),
            "exceptions.$[target].resolutionNote": dto.note.trim(),
          },
        },
        {
          returnDocument: "after",
          arrayFilters: [
            {
              "target._id": new Types.ObjectId(exceptionId),
              "target.resolvedAt": { $exists: false },
            },
          ],
        },
      )
      .exec();
    if (!run)
      throw apiNotFound(
        "Reconciliation run not found",
        "RECONCILIATION_RUN_NOT_FOUND",
      );
    if (!run.exceptions.some((exception) => exception._id.equals(exceptionId)))
      throw apiNotFound(
        "Exception not found",
        "RECONCILIATION_EXCEPTION_NOT_FOUND",
      );
    return this.toRunView(run, true);
  }

  /**
   * Everything about money that needs a human right now, from live data
   * (not only runs): unrefunded duplicates, flagged webhooks, failed or
   * stuck refunds, dashboard refunds to review, missing earnings, stale
   * processing, and unresolved run exceptions.
   */
  async exceptions(): Promise<PaymentExceptionsView> {
    const now = Date.now();
    const since = new Date(now - EXCEPTION_WINDOW_MS);
    const [
      duplicates,
      webhooks,
      failedRefunds,
      stuckRefunds,
      reviews,
      missingEarnings,
      staleProcessing,
      ledgerPending,
      runs,
    ] = await Promise.all([
      this.paymentModel
        .find({
          "duplicateCaptures.0": { $exists: true },
        })
        .select("rideCode duplicateCaptures")
        .limit(200)
        .exec(),
      this.webhookModel
        .find({
          status: {
            $in: [WebhookEventStatus.FLAGGED, WebhookEventStatus.FAILED],
          },
          updatedAt: { $gte: since },
        })
        .sort({ updatedAt: -1 })
        .limit(100)
        .lean()
        .exec(),
      this.refundModel
        .find({ status: RefundStatus.FAILED, failedAt: { $gte: since } })
        .sort({ failedAt: -1 })
        .limit(100)
        .exec(),
      this.refundModel
        .find({
          $or: [
            {
              status: RefundStatus.REQUESTED,
              createdAt: { $lte: new Date(now - 30 * 60_000) },
            },
            {
              status: RefundStatus.PENDING,
              createdAt: { $lte: new Date(now - 3 * DAY_MS) },
            },
          ],
        })
        .limit(100)
        .exec(),
      this.refundModel.find({ needsReview: true }).limit(100).exec(),
      this.paymentModel
        .find({
          status: PaymentStatus.CAPTURED,
          earningId: { $exists: false },
          paidAt: { $lte: new Date(now - 10 * 60_000) },
        })
        .select("rideCode paidAt amountPaise")
        .limit(100)
        .exec(),
      this.paymentModel
        .find({
          status: { $in: [PaymentStatus.CREATED, PaymentStatus.AUTHORIZED] },
          processingSince: { $lte: new Date(now - 30 * 60_000) },
        })
        .select("rideCode processingSince processingPaymentId amountPaise")
        .limit(100)
        .exec(),
      this.refundModel
        .find({
          status: RefundStatus.PROCESSED,
          ledgerState: RefundLedgerState.PENDING,
          needsReview: { $ne: true },
          processedAt: { $lte: new Date(now - 30 * 60_000) },
        })
        .limit(100)
        .exec(),
      this.runModel
        .find({ startedAt: { $gte: since }, "exceptions.0": { $exists: true } })
        .sort({ startedAt: -1 })
        .limit(30)
        .exec(),
    ]);

    const items: PaymentExceptionItem[] = [];
    for (const payment of duplicates)
      for (const duplicate of payment.duplicateCaptures)
        if (
          duplicate.refundState !== PaymentRefundState.FULL &&
          duplicate.refundState !== PaymentRefundState.PENDING
        )
          items.push({
            kind: "DUPLICATE_UNREFUNDED",
            severity: "CRITICAL",
            paymentId: payment._id.toString(),
            rideCode: payment.rideCode,
            reference: duplicate.razorpayPaymentId,
            amount: toRupees(duplicate.amountPaise),
            detail: "Customer paid twice — refund the duplicate",
            at: duplicate.detectedAt,
          });
    for (const event of webhooks)
      items.push({
        kind:
          event.status === WebhookEventStatus.FLAGGED
            ? "WEBHOOK_FLAGGED"
            : "WEBHOOK_FAILED",
        severity:
          event.status === WebhookEventStatus.FLAGGED ? "CRITICAL" : "WARNING",
        reference:
          event.razorpayPaymentId ?? event.razorpayOrderId ?? event.eventId,
        detail: `${event.event}: ${event.detail ?? "processing failed"}`,
        at: event.updatedAt ?? event.createdAt ?? new Date(),
      });
    for (const refund of failedRefunds)
      items.push({
        kind: "REFUND_FAILED",
        severity: "WARNING",
        paymentId: refund.paymentId.toString(),
        rideCode: refund.rideCode,
        reference: refund.razorpayRefundId ?? refund._id.toString(),
        amount: toRupees(refund.amountPaise),
        detail: refund.failureReason ?? "Refund failed",
        at: refund.failedAt ?? refund.updatedAt!,
      });
    for (const refund of stuckRefunds)
      items.push({
        kind: "REFUND_STUCK",
        severity: "WARNING",
        paymentId: refund.paymentId.toString(),
        rideCode: refund.rideCode,
        reference: refund.razorpayRefundId ?? refund._id.toString(),
        amount: toRupees(refund.amountPaise),
        detail:
          refund.status === RefundStatus.REQUESTED
            ? "Razorpay has not confirmed this refund"
            : "Refund pending at Razorpay for over 3 days",
        at: refund.createdAt!,
      });
    for (const refund of reviews)
      items.push({
        kind: "REFUND_REVIEW",
        severity: "INFO",
        paymentId: refund.paymentId.toString(),
        rideCode: refund.rideCode,
        reference: refund.razorpayRefundId,
        amount: toRupees(refund.amountPaise),
        detail:
          "Refund made in the Razorpay dashboard — decide the driver's share",
        at: refund.createdAt!,
      });
    for (const payment of missingEarnings)
      items.push({
        kind: "EARNING_MISSING",
        severity: "WARNING",
        paymentId: payment._id.toString(),
        rideCode: payment.rideCode,
        amount: toRupees(payment.amountPaise),
        detail:
          "Paid but the driver's earning is not recorded yet (retried automatically)",
        at: payment.paidAt!,
      });
    for (const payment of staleProcessing)
      items.push({
        kind: "PROCESSING_STALE",
        severity: "WARNING",
        paymentId: payment._id.toString(),
        rideCode: payment.rideCode,
        reference: payment.processingPaymentId,
        amount: toRupees(payment.amountPaise),
        detail:
          "Razorpay holds a payment we could not confirm for over 30 minutes",
        at: payment.processingSince!,
      });
    for (const refund of ledgerPending)
      items.push({
        kind: "LEDGER_PENDING",
        severity: "WARNING",
        paymentId: refund.paymentId.toString(),
        rideCode: refund.rideCode,
        reference: refund._id.toString(),
        amount: toRupees(refund.amountPaise),
        detail:
          "Refund processed but the driver's clawback is not recorded yet (retried automatically)",
        at: refund.processedAt!,
      });
    for (const run of runs)
      for (const exception of run.exceptions)
        if (
          !exception.healed &&
          !exception.resolvedAt &&
          exception.severity !== ReconciliationSeverity.INFO
        )
          items.push({
            kind: "RUN_EXCEPTION",
            severity: exception.severity,
            paymentId: exception.paymentId?.toString(),
            rideCode: exception.rideCode,
            reference: exception.razorpayPaymentId,
            detail: `${exception.type}: ${exception.detail}`,
            at: run.startedAt,
            runId: run._id.toString(),
            exceptionId: exception._id.toString(),
          });

    const rank = { CRITICAL: 0, WARNING: 1, INFO: 2 } as const;
    items.sort(
      (a, b) =>
        rank[a.severity] - rank[b.severity] ||
        new Date(b.at).getTime() - new Date(a.at).getTime(),
    );
    const counts = { CRITICAL: 0, WARNING: 0, INFO: 0 };
    for (const item of items) counts[item.severity] += 1;
    const lastRun = await this.runModel
      .findOne()
      .sort({ startedAt: -1 })
      .exec();
    return {
      counts,
      items,
      lastRun: lastRun ? this.toRunView(lastRun, false) : null,
    };
  }

  private toRunView(
    run: PaymentReconciliationRunDocument,
    withExceptions: boolean,
  ): ReconciliationRunView {
    const unresolved = run.exceptions.filter(
      (exception) => !exception.healed && !exception.resolvedAt,
    ).length;
    return {
      id: run._id.toString(),
      key: run.key,
      trigger: run.trigger,
      from: run.from,
      to: run.to,
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      stats: {
        gatewayPayments: run.stats?.gatewayPayments ?? 0,
        ridePayments: run.stats?.ridePayments ?? 0,
        foreignPayments: run.stats?.foreignPayments ?? 0,
        matched: run.stats?.matched ?? 0,
        recordedChecked: run.stats?.recordedChecked ?? 0,
        exceptions: run.stats?.exceptions ?? 0,
        healed: run.stats?.healed ?? 0,
        gatewayCaptured: toRupees(run.stats?.gatewayCapturedPaise ?? 0),
        recordedCaptured: toRupees(run.stats?.recordedCapturedPaise ?? 0),
      },
      unresolved,
      truncated: run.truncated,
      error: run.error,
      exceptions: withExceptions
        ? run.exceptions.map((exception) => ({
            id: exception._id.toString(),
            type: exception.type,
            severity: exception.severity,
            paymentId: exception.paymentId?.toString(),
            rideCode: exception.rideCode,
            razorpayPaymentId: exception.razorpayPaymentId,
            razorpayOrderId: exception.razorpayOrderId,
            expected: exception.expected,
            actual: exception.actual,
            detail: exception.detail,
            healed: exception.healed,
            resolvedAt: exception.resolvedAt,
            resolutionNote: exception.resolutionNote,
          }))
        : undefined,
    };
  }
}
