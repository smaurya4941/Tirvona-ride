import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectModel } from "@nestjs/mongoose";
import type { Model, QueryFilter } from "mongoose";
import { Types } from "mongoose";
import {
  ApiException,
  apiBadRequest,
  apiNotFound,
} from "../../common/exceptions/api.exception";
import { toPaise, toRupees } from "../../common/utils/money";
import { DomainEventsService } from "../../infrastructure/events/domain-events.service";
import { EarningsService } from "../earnings/earnings.service";
import { RidePaymentStateService } from "../rides/ride-payment-state.service";
import { RidePaymentStatus } from "../rides/ride-payment-status";
import { User } from "../users/schemas/user.schema";
import type {
  AdminRefundsQueryDto,
  CreateRefundDto,
  ReviewRefundDto,
} from "./dto/refund.dto";
import {
  PAYMENT_APP_TAG,
  PaymentEventSource,
  PaymentGateway,
  PaymentStatus,
  SETTLED_PAYMENT_STATUSES,
} from "./interfaces/payment-status";
import {
  DEFAULT_DRIVER_IMPACT,
  PaymentRefundState,
  RefundDriverImpact,
  RefundLedgerState,
  RefundReason,
  RefundSource,
  RefundStatus,
  RefundTarget,
} from "./interfaces/refund-status";
import type {
  AdminRefundListItem,
  CustomerRefundView,
  RefundView,
} from "./interfaces/payment-views";
import {
  RazorpayGateway,
  RazorpayGatewayError,
} from "./razorpay/razorpay.gateway";
import type { RazorpayRefund } from "./razorpay/razorpay.types";
import { Payment } from "./schemas/payment.schema";
import type { PaymentDocument, PaymentEvent } from "./schemas/payment.schema";
import { PaymentRefund } from "./schemas/payment-refund.schema";
import type { PaymentRefundDocument } from "./schemas/payment-refund.schema";

// Razorpay's smallest refund (₹1).
const MIN_REFUND_PAISE = 100;
const REFUND_LOCK_MS = 15_000;
const REFUND_LOCK_WAIT_MS = 8_000;
const MAX_EVENTS = 100;
const MAX_TOTALS_ATTEMPTS = 6;
/** A REQUESTED refund Razorpay has not registered after this long never will be. */
const REQUESTED_ABANDON_MS = 15 * 60_000;

const RAZORPAY_STATUS: Record<RazorpayRefund["status"], RefundStatus> = {
  pending: RefundStatus.PENDING,
  processed: RefundStatus.PROCESSED,
  failed: RefundStatus.FAILED,
};

const isDuplicateKey = (error: unknown, index?: string): boolean => {
  const mongoError = error as { code?: number; message?: string } | undefined;
  return (
    mongoError?.code === 11000 &&
    (!index || (mongoError.message ?? "").includes(index))
  );
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const nameOf = (
  user?: { firstName?: string; lastName?: string } | null,
): string => [user?.firstName, user?.lastName].filter(Boolean).join(" ");
const noteOf = (
  notes: RazorpayRefund["notes"],
  key: string,
): string | undefined =>
  notes && !Array.isArray(notes) && typeof notes[key] === "string"
    ? notes[key]
    : undefined;

/** Customer-facing wording for a refund reason (never the admin's note). */
const REASON_LABELS: Record<RefundReason, string> = {
  [RefundReason.ADMIN_REFUND]: "Refund from Tirvona",
  [RefundReason.RIDE_CANCELLED]: "Ride cancelled",
  [RefundReason.FARE_ADJUSTMENT]: "Fare adjustment",
  [RefundReason.CUSTOMER_SUPPORT]: "Customer support",
  [RefundReason.DUPLICATE_PAYMENT]: "Duplicate payment",
  [RefundReason.SYSTEM_ERROR]: "Payment correction",
  [RefundReason.EXTERNAL]: "Refund",
};

/**
 * Refunds of captured Razorpay payments — full or partial, of the ride's
 * payment or of a duplicate capture — and their consequences:
 *
 *  - over-refunding is impossible: requests for one payment are serialised
 *    by a short lock, and the refundable amount is computed from every
 *    active refund (requested, pending, processed) of that payment;
 *  - the payment's refund totals and status are always *recomputed* from
 *    `payment_refunds` under a sequence guard, so repeated or reordered
 *    webhooks converge on the right numbers;
 *  - a processed refund of the ride's payment claws back the driver's share
 *    (unless the refund is Tirvona's to bear), exactly once per refund;
 *  - refunds made in the Razorpay dashboard are discovered (webhook or
 *    reconciliation) and recorded, flagged for an admin to review.
 */
@Injectable()
export class RefundsService {
  private readonly logger = new Logger(RefundsService.name);
  private readonly refundWindowMs: number;

  constructor(
    @InjectModel(Payment.name) private readonly paymentModel: Model<Payment>,
    @InjectModel(PaymentRefund.name)
    private readonly refundModel: Model<PaymentRefund>,
    @InjectModel(User.name) private readonly userModel: Model<User>,
    private readonly gateway: RazorpayGateway,
    private readonly rides: RidePaymentStateService,
    private readonly earnings: EarningsService,
    private readonly events: DomainEventsService,
    config: ConfigService,
  ) {
    this.refundWindowMs =
      config.getOrThrow<number>("paymentRefundWindowDays") * 86_400_000;
  }

  // ── Admin: request a refund ───────────────────────────────────────────

  /**
   * Refund (part of) a captured payment. Validates the payment, reserves
   * the amount under the per-payment lock, records the refund, then asks
   * Razorpay. A timeout leaves the refund REQUESTED (the reconciler finds it
   * at Razorpay by our id); an outright rejection marks it FAILED and frees
   * the amount.
   */
  async request(
    adminUserId: string,
    paymentId: string,
    dto: CreateRefundDto,
  ): Promise<RefundView> {
    const replay = await this.refundModel
      .findOne({ idempotencyKey: dto.idempotencyKey })
      .exec();
    if (replay) {
      if (!replay.paymentId.equals(paymentId))
        throw new ApiException(
          HttpStatus.CONFLICT,
          "This request id was used for another payment",
          "REFUND_IDEMPOTENCY_CONFLICT",
        );
      return this.toView(replay);
    }

    const payment = await this.paymentModel.findById(paymentId).exec();
    if (!payment) throw apiNotFound("Payment not found", "PAYMENT_NOT_FOUND");
    this.assertRefundable(payment, dto);
    const target = dto.target ?? RefundTarget.PAYMENT;
    const razorpayPaymentId =
      target === RefundTarget.PAYMENT
        ? payment.razorpayPaymentId!
        : dto.razorpayPaymentId!;

    const locked = await this.lock(payment);
    let refund: PaymentRefundDocument;
    try {
      const capturedPaise =
        target === RefundTarget.PAYMENT
          ? payment.amountPaise
          : payment.duplicateCaptures.find(
              (duplicate) => duplicate.razorpayPaymentId === razorpayPaymentId,
            )!.amountPaise;
      const reserved = await this.reservedPaise(locked._id, razorpayPaymentId);
      const refundable = capturedPaise - reserved;
      if (refundable < MIN_REFUND_PAISE)
        throw new ApiException(
          HttpStatus.CONFLICT,
          "Nothing left to refund on this payment",
          "REFUND_NOTHING_LEFT",
          {
            refunded: toRupees(reserved),
          },
        );
      const amountPaise =
        dto.amount === undefined ? refundable : toPaise(dto.amount);
      if (amountPaise < MIN_REFUND_PAISE || amountPaise > refundable)
        throw apiBadRequest(
          `Refund between ₹${toRupees(MIN_REFUND_PAISE)} and ₹${toRupees(refundable)}`,
          "REFUND_AMOUNT_INVALID",
        );
      // A duplicate capture was never revenue: it is returned whole.
      if (
        target === RefundTarget.DUPLICATE_CAPTURE &&
        amountPaise !== refundable
      )
        throw apiBadRequest(
          "A duplicate payment is refunded in full",
          "REFUND_AMOUNT_INVALID",
        );

      const reason =
        target === RefundTarget.DUPLICATE_CAPTURE
          ? RefundReason.DUPLICATE_PAYMENT
          : dto.reason;
      try {
        refund = await this.refundModel.create({
          paymentId: locked._id,
          rideId: locked.rideId,
          rideCode: locked.rideCode,
          customerId: locked.customerId,
          driverId: locked.driverId,
          target,
          razorpayPaymentId,
          amountPaise,
          currency: locked.currency,
          reason,
          note: dto.note.trim(),
          driverImpact:
            target === RefundTarget.DUPLICATE_CAPTURE
              ? RefundDriverImpact.NONE
              : (dto.driverImpact ?? DEFAULT_DRIVER_IMPACT[reason]),
          status: RefundStatus.REQUESTED,
          source: RefundSource.ADMIN,
          requestedBy: new Types.ObjectId(adminUserId),
          idempotencyKey: dto.idempotencyKey,
          ledgerState: RefundLedgerState.PENDING,
        });
      } catch (error) {
        if (!isDuplicateKey(error, "uniq_refund_idempotency_key")) throw error;
        const winner = await this.refundModel
          .findOne({ idempotencyKey: dto.idempotencyKey })
          .exec();
        if (!winner) throw error;
        return this.toView(winner);
      }
      await this.pushEvent(locked._id, {
        type: "REFUND_REQUESTED",
        source: PaymentEventSource.ADMIN,
        actorId: new Types.ObjectId(adminUserId),
        razorpayPaymentId,
        refundId: refund._id,
        amountPaise,
        detail: `${reason}${target === RefundTarget.DUPLICATE_CAPTURE ? " (duplicate capture)" : ""}: ${dto.note.trim()}`,
      });
      await this.recomputeTotals(locked._id);
    } finally {
      await this.unlock(payment._id);
    }

    this.logger.log(
      `Refund ${refund._id.toString()} requested: ${refund.amountPaise}p of ${razorpayPaymentId} (ride ${refund.rideCode}) by ${adminUserId}`,
    );
    return this.toView(await this.submit(refund));
  }

  /** Sends a REQUESTED refund to Razorpay and applies the answer. */
  private async submit(
    refund: PaymentRefundDocument,
  ): Promise<PaymentRefundDocument> {
    let gatewayRefund: RazorpayRefund;
    try {
      gatewayRefund = await this.gateway.createRefund({
        razorpayPaymentId: refund.razorpayPaymentId,
        amountPaise: refund.amountPaise,
        receipt: refund._id.toString(),
        notes: {
          app: PAYMENT_APP_TAG,
          tirvonaRefundId: refund._id.toString(),
          paymentId: refund.paymentId.toString(),
          rideCode: refund.rideCode,
          reason: refund.reason,
        },
      });
    } catch (error) {
      if (error instanceof RazorpayGatewayError && !error.transient) {
        // Razorpay said no (e.g. already fully refunded there, amount too
        // high, payment too old). Record why and free the amount.
        const failed = await this.transition(refund, RefundStatus.FAILED, {
          failureReason: error.message.slice(0, 300),
          source: PaymentEventSource.ADMIN,
        });
        throw new ApiException(
          HttpStatus.BAD_GATEWAY,
          `Razorpay refused the refund: ${error.message}`,
          "REFUND_REJECTED",
          {
            refundId: failed._id.toString(),
          },
        );
      }
      // Unknown outcome: keep it REQUESTED; reconciliation settles it.
      this.logger.warn(
        `Refund ${refund._id.toString()} sent but unconfirmed: ${(error as Error).message}`,
      );
      await this.pushEvent(refund.paymentId, {
        type: "REFUND_UNCONFIRMED",
        source: PaymentEventSource.SYSTEM,
        refundId: refund._id,
        detail: "Razorpay did not answer; will be checked again",
      });
      return (await this.refundModel.findById(refund._id).exec()) ?? refund;
    }
    return this.applyGatewayRefund(
      refund,
      gatewayRefund,
      PaymentEventSource.ADMIN,
    );
  }

  // ── Gateway → Tirvona ─────────────────────────────────────────────────

  /**
   * What Razorpay says about one of its refunds (webhook, reconciliation).
   * Finds our record by Razorpay id, then by our id in the notes; a refund
   * made in the Razorpay dashboard for one of our payments is recorded as
   * EXTERNAL and flagged for review. Returns null when the refund is not
   * for a Tirvona Ride payment (another app on the same account).
   */
  async syncFromGateway(
    gatewayRefund: RazorpayRefund,
    source: PaymentEventSource,
  ): Promise<PaymentRefundDocument | null> {
    let refund = await this.refundModel
      .findOne({ razorpayRefundId: gatewayRefund.id })
      .exec();
    if (!refund) {
      const ours = noteOf(gatewayRefund.notes, "tirvonaRefundId");
      if (ours && Types.ObjectId.isValid(ours))
        refund = await this.refundModel
          .findOne({
            _id: new Types.ObjectId(ours),
            razorpayPaymentId: gatewayRefund.payment_id,
          })
          .exec();
    }
    if (!refund) refund = await this.recordExternal(gatewayRefund, source);
    if (!refund) return null;
    return this.applyGatewayRefund(refund, gatewayRefund, source);
  }

  /**
   * Re-reads every refund of a payment (and of its duplicate captures) from
   * Razorpay and applies them; REQUESTED refunds Razorpay never registered
   * are failed after a grace period. Never throws for gateway trouble.
   */
  async syncPayment(
    paymentId: Types.ObjectId,
    source: PaymentEventSource,
  ): Promise<void> {
    const payment = await this.paymentModel.findById(paymentId).exec();
    if (
      !payment ||
      payment.gateway !== PaymentGateway.RAZORPAY ||
      !this.gateway.isConfigured
    )
      return;
    const razorpayIds = [
      payment.razorpayPaymentId,
      ...payment.duplicateCaptures.map(
        (duplicate) => duplicate.razorpayPaymentId,
      ),
    ].filter((id): id is string => Boolean(id));
    const seen = new Set<string>();
    try {
      for (const razorpayPaymentId of razorpayIds)
        for (const gatewayRefund of await this.gateway.fetchPaymentRefunds(
          razorpayPaymentId,
        )) {
          const synced = await this.syncFromGateway(gatewayRefund, source);
          if (synced) seen.add(synced._id.toString());
        }
    } catch (error) {
      this.logger.warn(
        `Refund sync for payment ${paymentId.toString()} deferred: ${(error as Error).message}`,
      );
      return;
    }
    const abandoned = await this.refundModel
      .find({
        paymentId,
        status: RefundStatus.REQUESTED,
        razorpayRefundId: { $exists: false },
        createdAt: { $lte: new Date(Date.now() - REQUESTED_ABANDON_MS) },
      })
      .exec();
    for (const refund of abandoned)
      if (!seen.has(refund._id.toString()))
        await this.transition(refund, RefundStatus.FAILED, {
          failureReason:
            "Razorpay did not register this refund. No money was returned; request it again.",
          source,
        });
    await this.recomputeTotals(paymentId);
  }

  /** Applies Razorpay's refund entity to our record (idempotent). */
  private async applyGatewayRefund(
    refund: PaymentRefundDocument,
    gatewayRefund: RazorpayRefund,
    source: PaymentEventSource,
  ): Promise<PaymentRefundDocument> {
    if (
      gatewayRefund.amount !== refund.amountPaise ||
      gatewayRefund.currency !== refund.currency
    )
      this.logger.error(
        `Refund ${refund._id.toString()}: Razorpay ${gatewayRefund.id} is ${gatewayRefund.amount} ${gatewayRefund.currency}, ` +
          `expected ${refund.amountPaise} ${refund.currency} — Razorpay's amount is recorded`,
      );
    const reference =
      gatewayRefund.acquirer_data?.arn ||
      gatewayRefund.acquirer_data?.rrn ||
      gatewayRefund.acquirer_data?.utr;
    const facts: Record<string, unknown> = {
      razorpayRefundId: gatewayRefund.id,
      amountPaise: gatewayRefund.amount,
      lastCheckedAt: new Date(),
      ...(gatewayRefund.speed_processed
        ? { speedProcessed: gatewayRefund.speed_processed }
        : {}),
      ...(reference ? { acquirerReference: reference } : {}),
    };
    try {
      await this.refundModel
        .updateOne({ _id: refund._id }, { $set: facts })
        .exec();
    } catch (error) {
      if (!isDuplicateKey(error, "uniq_razorpay_refund_id")) throw error;
      // Another record already owns this Razorpay refund: that one is the truth.
      const owner = await this.refundModel
        .findOne({ razorpayRefundId: gatewayRefund.id })
        .exec();
      this.logger.error(
        `Refund ${refund._id.toString()} collides with ${owner?._id.toString()} on ${gatewayRefund.id}`,
      );
      return owner ?? refund;
    }
    const current =
      (await this.refundModel.findById(refund._id).exec()) ?? refund;
    return this.transition(current, RAZORPAY_STATUS[gatewayRefund.status], {
      source,
    });
  }

  // ── State transitions ─────────────────────────────────────────────────

  /**
   * Compare-and-set on the refund's status, then the consequences: payment
   * totals, ride status, driver ledger, notifications. A report of the
   * current status only re-runs the (idempotent) consequences.
   */
  private async transition(
    refund: PaymentRefundDocument,
    to: RefundStatus,
    options: { source: PaymentEventSource; failureReason?: string },
  ): Promise<PaymentRefundDocument> {
    const allowedFrom: Record<RefundStatus, RefundStatus[]> = {
      [RefundStatus.REQUESTED]: [],
      [RefundStatus.PENDING]: [RefundStatus.REQUESTED],
      // A refund failed by timeout can still turn out processed.
      [RefundStatus.PROCESSED]: [
        RefundStatus.REQUESTED,
        RefundStatus.PENDING,
        RefundStatus.FAILED,
      ],
      [RefundStatus.FAILED]: [RefundStatus.REQUESTED, RefundStatus.PENDING],
    };
    const now = new Date();
    const set: Record<string, unknown> = { status: to };
    if (to === RefundStatus.PROCESSED) set.processedAt = now;
    if (to === RefundStatus.FAILED) {
      set.failedAt = now;
      set.failureReason = options.failureReason ?? "Refund failed at Razorpay";
    }
    const moved = await this.refundModel
      .findOneAndUpdate(
        { _id: refund._id, status: { $in: allowedFrom[to] } },
        { $set: set },
        { returnDocument: "after" },
      )
      .exec();
    const current =
      moved ?? (await this.refundModel.findById(refund._id).exec()) ?? refund;

    if (moved) {
      this.logger.log(
        `Refund ${refund._id.toString()} ${refund.status} → ${to} via ${options.source}`,
      );
      await this.pushEvent(current.paymentId, {
        type: `REFUND_${to}`,
        source: options.source,
        fromStatus: refund.status,
        toStatus: to,
        razorpayPaymentId: current.razorpayPaymentId,
        refundId: current._id,
        amountPaise: current.amountPaise,
        detail:
          [current.razorpayRefundId, current.failureReason]
            .filter(Boolean)
            .join(" · ") || undefined,
      });
    }
    await this.afterChange(current, Boolean(moved));
    return (await this.refundModel.findById(refund._id).exec()) ?? current;
  }

  /** Totals, ride status, ledger and notifications — all safe to repeat. */
  private async afterChange(
    refund: PaymentRefundDocument,
    changed: boolean,
  ): Promise<void> {
    const totals = await this.recomputeTotals(refund.paymentId);
    if (
      totals &&
      refund.target === RefundTarget.PAYMENT &&
      totals.processedPaise > 0
    )
      await this.rides.apply({
        rideId: refund.rideId,
        from: [RidePaymentStatus.SUCCESS, RidePaymentStatus.PARTIALLY_REFUNDED],
        to: totals.full
          ? RidePaymentStatus.REFUNDED
          : RidePaymentStatus.PARTIALLY_REFUNDED,
        payment: { refundedAmount: toRupees(totals.processedPaise) },
      });
    if (refund.status === RefundStatus.PROCESSED)
      await this.applyLedger(refund);
    if (refund.status !== RefundStatus.REQUESTED)
      this.events.emit("payment.refund_updated", {
        refundId: refund._id.toString(),
        paymentId: refund.paymentId.toString(),
        rideId: refund.rideId.toString(),
        rideCode: refund.rideCode,
        customerId: refund.customerId.toString(),
        amount: toRupees(refund.amountPaise),
        currency: refund.currency,
        status: refund.status,
        target: refund.target,
        changed,
      });
  }

  /** A processed refund of the ride payment claws back the driver's share — once. */
  async applyLedger(refund: PaymentRefundDocument): Promise<void> {
    if (
      refund.status !== RefundStatus.PROCESSED ||
      refund.ledgerState !== RefundLedgerState.PENDING
    )
      return;
    if (
      refund.target !== RefundTarget.PAYMENT ||
      refund.driverImpact === RefundDriverImpact.NONE ||
      refund.needsReview
    ) {
      if (!refund.needsReview)
        await this.refundModel
          .updateOne(
            { _id: refund._id, ledgerState: RefundLedgerState.PENDING },
            { $set: { ledgerState: RefundLedgerState.NOT_APPLICABLE } },
          )
          .exec();
      return;
    }
    const payment = await this.paymentModel
      .findById(refund.paymentId)
      .select("amountPaise")
      .lean()
      .exec();
    if (!payment) return;
    try {
      const outcome = await this.earnings.recordRefundClawback({
        refundId: refund._id,
        paymentId: refund.paymentId,
        paidAmountPaise: payment.amountPaise,
        refundAmountPaise: refund.amountPaise,
        reason: refund.reason,
      });
      if (outcome.status === "NO_EARNING") return; // reconciler retries once the earning exists
      const updated = await this.refundModel
        .updateOne(
          { _id: refund._id, ledgerState: RefundLedgerState.PENDING },
          {
            $set:
              outcome.status === "RECORDED"
                ? {
                    ledgerState: RefundLedgerState.RECORDED,
                    adjustmentId: outcome.adjustment._id,
                  }
                : { ledgerState: RefundLedgerState.NOT_APPLICABLE },
          },
        )
        .exec();
      if (outcome.status === "RECORDED" && updated.modifiedCount) {
        const adjustment = outcome.adjustment;
        await this.pushEvent(refund.paymentId, {
          type: "EARNING_ADJUSTED",
          source: PaymentEventSource.SYSTEM,
          refundId: refund._id,
          amountPaise: adjustment.amountPaise,
          detail: `Driver −${adjustment.amountPaise}p (gross ${adjustment.grossReversalPaise}p, commission ${adjustment.commissionReversalPaise}p)`,
        });
        this.events.emit("earnings.adjusted", {
          adjustmentId: adjustment._id.toString(),
          driverUserId: adjustment.driverUserId.toString(),
          rideId: adjustment.rideId.toString(),
          rideCode: adjustment.rideCode,
          amount: toRupees(adjustment.amountPaise),
          refundAmount: toRupees(adjustment.refundAmountPaise),
        });
      }
    } catch (error) {
      this.logger.error(
        `Ledger for refund ${refund._id.toString()} not recorded yet (will retry)`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /**
   * The payment's refund totals and status, recomputed from all its refunds.
   * Guarded by `refundSeq`: a writer whose read is older than another
   * write loses and recomputes, so the last write always reflects every
   * refund change that happened before it.
   */
  async recomputeTotals(
    paymentId: Types.ObjectId,
  ): Promise<{ processedPaise: number; full: boolean } | null> {
    for (let attempt = 0; attempt < MAX_TOTALS_ATTEMPTS; attempt += 1) {
      const payment = await this.paymentModel.findById(paymentId).exec();
      if (!payment) return null;
      const refunds = await this.refundModel
        .find({ paymentId })
        .sort({ createdAt: 1, _id: 1 })
        .exec();
      const own = refunds.filter(
        (refund) => refund.target === RefundTarget.PAYMENT,
      );
      const sum = (rows: PaymentRefundDocument[], statuses: RefundStatus[]) =>
        rows
          .filter((row) => statuses.includes(row.status))
          .reduce((total, row) => total + row.amountPaise, 0);
      const processed = sum(own, [RefundStatus.PROCESSED]);
      const pending = sum(own, [RefundStatus.REQUESTED, RefundStatus.PENDING]);
      const full = processed >= payment.amountPaise;
      const latestProcessed = [...own]
        .filter((row) => row.status === RefundStatus.PROCESSED)
        .sort(
          (a, b) =>
            (a.processedAt?.getTime() ?? 0) - (b.processedAt?.getTime() ?? 0),
        )
        .pop();
      const latest = own[own.length - 1];
      const state = full
        ? PaymentRefundState.FULL
        : processed > 0
          ? PaymentRefundState.PARTIAL
          : pending > 0
            ? PaymentRefundState.PENDING
            : latest?.status === RefundStatus.FAILED
              ? PaymentRefundState.FAILED
              : undefined;

      const set: Record<string, unknown> = { refundPendingPaise: pending };
      const unset: Record<string, 1> = {};
      if (state) set.refundStatus = state;
      else unset.refundStatus = 1;
      if (own.length) {
        set.refundAmountPaise = processed;
        if (latestProcessed) {
          set.refundedAt = latestProcessed.processedAt;
          if (latestProcessed.razorpayRefundId)
            set.refundId = latestProcessed.razorpayRefundId;
        }
        // Only a settled payment's status follows its refunds.
        if (SETTLED_PAYMENT_STATUSES.includes(payment.status))
          set.status = full
            ? PaymentStatus.REFUNDED
            : processed > 0
              ? PaymentStatus.PARTIALLY_REFUNDED
              : PaymentStatus.CAPTURED;
      } else {
        // No refund records (e.g. refunds synced before this ledger existed):
        // leave the stored status and amounts alone.
        delete unset.refundStatus;
        if ((payment.refundAmountPaise ?? 0) > 0) delete set.refundStatus;
      }
      payment.duplicateCaptures.forEach((duplicate, index) => {
        const mine = refunds.filter(
          (row) =>
            row.target === RefundTarget.DUPLICATE_CAPTURE &&
            row.razorpayPaymentId === duplicate.razorpayPaymentId,
        );
        const done = sum(mine, [RefundStatus.PROCESSED]);
        const onWay = sum(mine, [RefundStatus.REQUESTED, RefundStatus.PENDING]);
        set[`duplicateCaptures.${index}.refundedPaise`] = done;
        set[`duplicateCaptures.${index}.refundState`] =
          done >= duplicate.amountPaise
            ? PaymentRefundState.FULL
            : onWay > 0
              ? PaymentRefundState.PENDING
              : done > 0
                ? PaymentRefundState.PARTIAL
                : mine.some((row) => row.status === RefundStatus.FAILED)
                  ? PaymentRefundState.FAILED
                  : PaymentRefundState.NONE;
      });

      const written = await this.paymentModel
        .updateOne(
          { _id: paymentId, refundSeq: payment.refundSeq ?? 0 },
          {
            $set: set,
            ...(Object.keys(unset).length ? { $unset: unset } : {}),
            $inc: { refundSeq: 1 },
          },
        )
        .exec();
      if (written.matchedCount) return { processedPaise: processed, full };
      // Legacy documents have no refundSeq: match on its absence once.
      if ((payment.refundSeq ?? 0) === 0) {
        const legacy = await this.paymentModel
          .updateOne(
            { _id: paymentId, refundSeq: { $exists: false } },
            {
              $set: { ...set, refundSeq: 1 },
              ...(Object.keys(unset).length ? { $unset: unset } : {}),
            },
          )
          .exec();
        if (legacy.matchedCount) return { processedPaise: processed, full };
      }
    }
    this.logger.warn(
      `Refund totals of payment ${paymentId.toString()} contended; the reconciler will settle them`,
    );
    return null;
  }

  // ── Admin: review a dashboard refund ──────────────────────────────────

  /** Decide the driver impact of a refund made outside Tirvona. */
  async review(
    adminUserId: string,
    refundId: string,
    dto: ReviewRefundDto,
  ): Promise<RefundView> {
    const refund = await this.refundModel
      .findOneAndUpdate(
        { _id: new Types.ObjectId(refundId), needsReview: true },
        {
          $set: {
            needsReview: false,
            driverImpact: dto.driverImpact,
            note: dto.note.trim(),
          },
        },
        { returnDocument: "after" },
      )
      .exec();
    if (!refund) {
      if (!(await this.refundModel.exists({ _id: refundId }).exec()))
        throw apiNotFound("Refund not found", "REFUND_NOT_FOUND");
      throw new ApiException(
        HttpStatus.CONFLICT,
        "This refund has already been reviewed",
        "REFUND_ALREADY_REVIEWED",
      );
    }
    await this.pushEvent(refund.paymentId, {
      type: "REFUND_REVIEWED",
      source: PaymentEventSource.ADMIN,
      actorId: new Types.ObjectId(adminUserId),
      refundId: refund._id,
      detail: `Driver impact ${dto.driverImpact}: ${dto.note.trim()}`,
    });
    await this.applyLedger(refund);
    return this.toView(
      (await this.refundModel.findById(refund._id).exec()) ?? refund,
    );
  }

  // ── Reads ─────────────────────────────────────────────────────────────

  async forPayment(paymentId: Types.ObjectId): Promise<RefundView[]> {
    const refunds = await this.refundModel
      .find({ paymentId })
      .sort({ createdAt: 1, _id: 1 })
      .exec();
    return this.toViews(refunds);
  }

  /** What the customer sees on the receipt: amounts, status, bank reference. */
  async forCustomer(paymentId: Types.ObjectId): Promise<CustomerRefundView[]> {
    const refunds = await this.refundModel
      .find({
        paymentId,
        target: RefundTarget.PAYMENT,
        status: { $ne: RefundStatus.REQUESTED },
      })
      .sort({ createdAt: 1, _id: 1 })
      .exec();
    return refunds
      .filter((refund) => refund.status !== RefundStatus.FAILED)
      .map((refund) => ({
        id: refund._id.toString(),
        amount: toRupees(refund.amountPaise),
        currency: refund.currency,
        status: refund.status,
        reason: REASON_LABELS[refund.reason],
        reference: refund.acquirerReference,
        createdAt: refund.createdAt!,
        processedAt: refund.processedAt,
      }));
  }

  async list(query: AdminRefundsQueryDto): Promise<{
    items: AdminRefundListItem[];
    page: number;
    limit: number;
    total: number;
    hasMore: boolean;
  }> {
    const filter: QueryFilter<PaymentRefund> = {};
    if (query.status) filter.status = query.status;
    if (query.reason) filter.reason = query.reason;
    if (query.needsReview !== undefined) filter.needsReview = query.needsReview;
    const [refunds, total] = await Promise.all([
      this.refundModel
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .exec(),
      this.refundModel.countDocuments(filter).exec(),
    ]);
    const views = await this.toViews(refunds);
    const customers = await this.userModel
      .find({ _id: { $in: refunds.map((refund) => refund.customerId) } })
      .select("firstName lastName phone")
      .lean()
      .exec();
    const customerById = new Map(
      customers.map((customer) => [customer._id.toString(), customer]),
    );
    return {
      items: views.map((view, index) => {
        const customer = customerById.get(refunds[index].customerId.toString());
        return {
          ...view,
          customer: customer
            ? { name: nameOf(customer) || "Customer", phone: customer.phone }
            : null,
        };
      }),
      page: query.page,
      limit: query.limit,
      total,
      hasMore: query.page * query.limit < total,
    };
  }

  /** Refund totals for the admin payments summary (paise). */
  async summary(
    since: Date,
  ): Promise<{
    refundedToday: number;
    refundedTotal: number;
    pending: number;
    failed: number;
    review: number;
  }> {
    const [processed, pending, failed, review] = await Promise.all([
      this.refundModel
        .aggregate<{ _id: null; today: number; total: number }>([
          {
            $match: {
              status: RefundStatus.PROCESSED,
              target: RefundTarget.PAYMENT,
            },
          },
          {
            $group: {
              _id: null,
              total: { $sum: "$amountPaise" },
              today: {
                $sum: {
                  $cond: [{ $gte: ["$processedAt", since] }, "$amountPaise", 0],
                },
              },
            },
          },
        ])
        .exec(),
      this.refundModel
        .countDocuments({
          status: { $in: [RefundStatus.REQUESTED, RefundStatus.PENDING] },
        })
        .exec(),
      this.refundModel
        .countDocuments({
          status: RefundStatus.FAILED,
          failedAt: { $gte: new Date(Date.now() - 30 * 86_400_000) },
        })
        .exec(),
      this.refundModel.countDocuments({ needsReview: true }).exec(),
    ]);
    return {
      refundedToday: processed[0]?.today ?? 0,
      refundedTotal: processed[0]?.total ?? 0,
      pending,
      failed,
      review,
    };
  }

  // ── Reconciler hooks ──────────────────────────────────────────────────

  /** Refunds whose Razorpay outcome we are still waiting for. */
  async findUnsettled(
    olderThan: Date,
    limit: number,
  ): Promise<PaymentRefundDocument[]> {
    return this.refundModel
      .find({
        status: { $in: [RefundStatus.REQUESTED, RefundStatus.PENDING] },
        createdAt: { $lte: olderThan },
        $or: [
          { lastCheckedAt: { $exists: false } },
          { lastCheckedAt: { $lte: olderThan } },
        ],
      })
      .sort({ createdAt: 1 })
      .limit(limit)
      .exec();
  }

  /** Processed refunds whose driver clawback is still to be written. */
  async findLedgerPending(limit: number): Promise<PaymentRefundDocument[]> {
    return this.refundModel
      .find({
        status: RefundStatus.PROCESSED,
        ledgerState: RefundLedgerState.PENDING,
        needsReview: { $ne: true },
      })
      .limit(limit)
      .exec();
  }

  /** One unsettled refund: ask Razorpay directly, or re-list the payment's refunds. */
  async resolve(
    refund: PaymentRefundDocument,
    source: PaymentEventSource,
  ): Promise<void> {
    await this.refundModel
      .updateOne({ _id: refund._id }, { $set: { lastCheckedAt: new Date() } })
      .exec();
    if (refund.razorpayRefundId) {
      try {
        await this.applyGatewayRefund(
          refund,
          await this.gateway.fetchRefund(
            refund.razorpayPaymentId,
            refund.razorpayRefundId,
          ),
          source,
        );
      } catch (error) {
        this.logger.warn(
          `Refund ${refund._id.toString()} check deferred: ${(error as Error).message}`,
        );
      }
      return;
    }
    await this.syncPayment(refund.paymentId, source);
  }

  // ── Internals ─────────────────────────────────────────────────────────

  private assertRefundable(
    payment: PaymentDocument,
    dto: CreateRefundDto,
  ): void {
    if (payment.gateway !== PaymentGateway.RAZORPAY)
      throw new ApiException(
        HttpStatus.CONFLICT,
        "Cash payments are settled with the customer directly, not through Razorpay",
        "REFUND_NOT_SUPPORTED",
      );
    if (!this.gateway.isConfigured)
      throw new ApiException(
        HttpStatus.SERVICE_UNAVAILABLE,
        "Razorpay is not configured",
        "PAYMENT_GATEWAY_NOT_CONFIGURED",
      );
    const target = dto.target ?? RefundTarget.PAYMENT;
    if (target === RefundTarget.DUPLICATE_CAPTURE) {
      if (
        !dto.razorpayPaymentId ||
        !payment.duplicateCaptures.some(
          (d) => d.razorpayPaymentId === dto.razorpayPaymentId,
        )
      )
        throw apiBadRequest(
          "That Razorpay payment is not a duplicate of this ride",
          "REFUND_TARGET_INVALID",
        );
      return;
    }
    if (
      !SETTLED_PAYMENT_STATUSES.includes(payment.status) ||
      !payment.razorpayPaymentId
    )
      throw new ApiException(
        HttpStatus.CONFLICT,
        "Only a captured payment can be refunded",
        "REFUND_NOT_ALLOWED",
        {
          status: payment.status,
        },
      );
    if (
      payment.paidAt &&
      Date.now() - payment.paidAt.getTime() > this.refundWindowMs
    )
      throw new ApiException(
        HttpStatus.CONFLICT,
        "This payment is too old to refund through Razorpay; settle it with the customer directly",
        "REFUND_WINDOW_EXPIRED",
      );
  }

  /** Requested + pending + processed refunds of one Razorpay payment (paise). */
  private async reservedPaise(
    paymentId: Types.ObjectId,
    razorpayPaymentId: string,
  ): Promise<number> {
    const [row] = await this.refundModel
      .aggregate<{ total: number }>([
        {
          $match: {
            paymentId,
            razorpayPaymentId,
            status: {
              $in: [
                RefundStatus.REQUESTED,
                RefundStatus.PENDING,
                RefundStatus.PROCESSED,
              ],
            },
          },
        },
        { $group: { _id: null, total: { $sum: "$amountPaise" } } },
      ])
      .exec();
    return row?.total ?? 0;
  }

  private async lock(payment: PaymentDocument): Promise<PaymentDocument> {
    const waitUntil = Date.now() + REFUND_LOCK_WAIT_MS;
    for (;;) {
      const now = new Date();
      const locked = await this.paymentModel
        .findOneAndUpdate(
          {
            _id: payment._id,
            $or: [
              { refundLockUntil: { $exists: false } },
              { refundLockUntil: { $lte: now } },
            ],
          },
          {
            $set: { refundLockUntil: new Date(now.getTime() + REFUND_LOCK_MS) },
          },
          { returnDocument: "after" },
        )
        .exec();
      if (locked) return locked;
      if (Date.now() > waitUntil)
        throw new ApiException(
          HttpStatus.CONFLICT,
          "Another refund of this payment is being processed. Try again.",
          "REFUND_IN_PROGRESS",
        );
      await sleep(200);
    }
  }

  private async unlock(paymentId: Types.ObjectId): Promise<void> {
    await this.paymentModel
      .updateOne({ _id: paymentId }, { $unset: { refundLockUntil: 1 } })
      .exec();
  }

  /** A refund Razorpay knows about but we don't: made in the dashboard. */
  private async recordExternal(
    gatewayRefund: RazorpayRefund,
    source: PaymentEventSource,
  ): Promise<PaymentRefundDocument | null> {
    const payment = await this.paymentModel
      .findOne({
        gateway: PaymentGateway.RAZORPAY,
        $or: [
          { razorpayPaymentId: gatewayRefund.payment_id },
          { "duplicateCaptures.razorpayPaymentId": gatewayRefund.payment_id },
        ],
      })
      .exec();
    if (!payment) return null;
    const target =
      payment.razorpayPaymentId === gatewayRefund.payment_id
        ? RefundTarget.PAYMENT
        : RefundTarget.DUPLICATE_CAPTURE;
    try {
      const refund = await this.refundModel.create({
        paymentId: payment._id,
        rideId: payment.rideId,
        rideCode: payment.rideCode,
        customerId: payment.customerId,
        driverId: payment.driverId,
        target,
        razorpayPaymentId: gatewayRefund.payment_id,
        razorpayRefundId: gatewayRefund.id,
        amountPaise: gatewayRefund.amount,
        currency: gatewayRefund.currency,
        reason:
          target === RefundTarget.DUPLICATE_CAPTURE
            ? RefundReason.DUPLICATE_PAYMENT
            : RefundReason.EXTERNAL,
        note: "Made in the Razorpay dashboard",
        driverImpact: RefundDriverImpact.NONE,
        status: RefundStatus.REQUESTED,
        source:
          source === PaymentEventSource.WEBHOOK
            ? RefundSource.WEBHOOK
            : RefundSource.RECONCILE,
        ledgerState: RefundLedgerState.PENDING,
        // Someone must decide whether the driver shares this refund.
        needsReview: target === RefundTarget.PAYMENT,
      });
      this.logger.warn(
        `Dashboard refund ${gatewayRefund.id} (${gatewayRefund.amount}p) on ride ${payment.rideCode} recorded — review driver impact`,
      );
      await this.pushEvent(payment._id, {
        type: "REFUND_EXTERNAL",
        source,
        razorpayPaymentId: gatewayRefund.payment_id,
        refundId: refund._id,
        amountPaise: gatewayRefund.amount,
        detail: `${gatewayRefund.id} made outside Tirvona`,
      });
      return refund;
    } catch (error) {
      if (!isDuplicateKey(error, "uniq_razorpay_refund_id")) throw error;
      return this.refundModel
        .findOne({ razorpayRefundId: gatewayRefund.id })
        .exec();
    }
  }

  private async pushEvent(
    paymentId: Types.ObjectId,
    event: Omit<PaymentEvent, "at"> & { at?: Date },
  ): Promise<void> {
    await this.paymentModel
      .updateOne(
        { _id: paymentId },
        {
          $push: {
            events: {
              $each: [{ ...event, at: event.at ?? new Date() }],
              $slice: -MAX_EVENTS,
            },
          },
        },
      )
      .exec();
  }

  private async toViews(
    refunds: PaymentRefundDocument[],
  ): Promise<RefundView[]> {
    const admins = await this.userModel
      .find({
        _id: {
          $in: refunds.map((refund) => refund.requestedBy).filter(Boolean),
        },
      })
      .select("firstName lastName")
      .lean()
      .exec();
    const adminName = new Map(
      admins.map((admin) => [admin._id.toString(), nameOf(admin) || "Admin"]),
    );
    const adjustments = new Map<string, { amount: number; status: string }>();
    const paymentIds = [
      ...new Set(
        refunds
          .filter((r) => r.adjustmentId)
          .map((r) => r.paymentId.toString()),
      ),
    ];
    for (const paymentId of paymentIds)
      for (const adjustment of await this.earnings.adjustmentsForPayment(
        new Types.ObjectId(paymentId),
      ))
        adjustments.set(adjustment.id, {
          amount: adjustment.amount,
          status: adjustment.status,
        });
    return refunds.map((refund) =>
      this.toView(
        refund,
        refund.requestedBy
          ? adminName.get(refund.requestedBy.toString())
          : undefined,
        adjustments,
      ),
    );
  }

  private toView(
    refund: PaymentRefundDocument,
    requestedByName?: string,
    adjustments?: Map<string, { amount: number; status: string }>,
  ): RefundView {
    const adjustment = refund.adjustmentId
      ? adjustments?.get(refund.adjustmentId.toString())
      : undefined;
    return {
      id: refund._id.toString(),
      paymentId: refund.paymentId.toString(),
      rideId: refund.rideId.toString(),
      rideCode: refund.rideCode,
      target: refund.target,
      razorpayPaymentId: refund.razorpayPaymentId,
      razorpayRefundId: refund.razorpayRefundId,
      amount: toRupees(refund.amountPaise),
      currency: refund.currency,
      reason: refund.reason,
      note: refund.note,
      driverImpact: refund.driverImpact,
      status: refund.status,
      failureReason: refund.failureReason,
      acquirerReference: refund.acquirerReference,
      speedProcessed: refund.speedProcessed,
      source: refund.source,
      requestedBy: refund.requestedBy
        ? {
            id: refund.requestedBy.toString(),
            name: requestedByName ?? "Admin",
          }
        : undefined,
      ledgerState: refund.ledgerState,
      adjustment: refund.adjustmentId
        ? {
            id: refund.adjustmentId.toString(),
            amount: adjustment?.amount,
            status: adjustment?.status,
          }
        : undefined,
      needsReview: refund.needsReview,
      createdAt: refund.createdAt!,
      processedAt: refund.processedAt,
      failedAt: refund.failedAt,
    };
  }
}
