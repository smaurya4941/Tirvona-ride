import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectModel } from "@nestjs/mongoose";
import type { Model, PipelineStage, QueryFilter } from "mongoose";
import { Types } from "mongoose";
import { apiNotFound } from "../../common/exceptions/api.exception";
import { toRupees } from "../../common/utils/money";
import {
  startOfDayInTimeZone,
  startOfMonthInTimeZone,
  startOfWeekInTimeZone,
} from "../../common/utils/time";
import { DriversService } from "../drivers/drivers.service";
import { refundClawback } from "./clawback";
import { splitFare } from "./commission";
import { CommissionService } from "./commission.service";
import type { DriverEarningsQueryDto } from "./dto/earnings-query.dto";
import {
  AdjustmentStatus,
  AdjustmentType,
  CommissionType,
  EarningStatus,
  EarningsPeriod,
  PaymentMode,
} from "./interfaces/earning-status";
import type {
  AdjustmentView,
  DriverEarningsResponse,
  EarningView,
  EarningsBalances,
  EarningsSummary,
  EarningsWindow,
} from "./interfaces/earning-views";
import { DriverEarning } from "./schemas/driver-earning.schema";
import type { DriverEarningDocument } from "./schemas/driver-earning.schema";
import { DriverEarningAdjustment } from "./schemas/driver-earning-adjustment.schema";
import type { DriverEarningAdjustmentDocument } from "./schemas/driver-earning-adjustment.schema";

export interface RefundClawbackInput {
  refundId: Types.ObjectId;
  paymentId: Types.ObjectId;
  /** What the customer paid (paise). */
  paidAmountPaise: number;
  refundAmountPaise: number;
  /** RefundReason, shown on the driver statement. */
  reason: string;
}

/** Outcome of applying a refund to the driver ledger. */
export type ClawbackOutcome =
  | { status: "RECORDED"; adjustment: DriverEarningAdjustmentDocument }
  /** No earning line yet (retry later). */
  | { status: "NO_EARNING" }
  /** Cash ride, or nothing left to reverse. */
  | { status: "NOT_APPLICABLE" };

export interface RecordEarningInput {
  paymentId: Types.ObjectId;
  rideId: Types.ObjectId;
  driverId: Types.ObjectId;
  driverUserId: Types.ObjectId;
  rideCode: string;
  rideType: string;
  pickupAddress?: string;
  destinationAddress?: string;
  rideCompletedAt: Date;
  grossFarePaise: number;
  /** Platform-funded promo discount on this ride (Phase 7), paise. */
  promoDiscountPaise?: number;
  currency: string;
  paymentMode: PaymentMode;
  paymentMethod?: string;
}

/** Ledger lines grouped by status: the driver's share and Tirvona's commission (paise). */
export interface StatusTotalsRow {
  _id: EarningStatus;
  amount: number;
  commission: number;
  /** Promo discounts on these lines (paise). */
  discount?: number;
}

/** `$group` stage producing StatusTotalsRow. */
export const STATUS_TOTALS = {
  _id: "$status",
  amount: { $sum: "$netEarningPaise" },
  commission: { $sum: "$commissionPaise" },
  discount: { $sum: { $ifNull: ["$promoDiscountPaise", 0] } },
} as const;

interface WindowTotals {
  net: number;
  gross: number;
  commission: number;
  rides: number;
}

const isDuplicateKey = (error: unknown): boolean => (error as { code?: number } | undefined)?.code === 11000;

/** `$group` stage summing a set of ledger lines (all paise). */
export const LEDGER_TOTALS = {
  _id: null,
  net: { $sum: "$netEarningPaise" },
  gross: { $sum: "$grossFarePaise" },
  commission: { $sum: "$commissionPaise" },
  rides: { $sum: 1 },
} as const;

export const toWindow = (totals?: Partial<WindowTotals>): EarningsWindow => ({
  net: toRupees(totals?.net ?? 0),
  gross: toRupees(totals?.gross ?? 0),
  commission: toRupees(totals?.commission ?? 0),
  rides: totals?.rides ?? 0,
});

/**
 * The driver earnings ledger: written once per paid ride (idempotently),
 * read by drivers. Admin reporting and payouts live in EarningsAdminService.
 */
@Injectable()
export class EarningsService {
  private readonly logger = new Logger(EarningsService.name);
  private readonly holdMs: number;
  private readonly timeZone: string;

  constructor(
    @InjectModel(DriverEarning.name) private readonly earningModel: Model<DriverEarning>,
    @InjectModel(DriverEarningAdjustment.name) private readonly adjustmentModel: Model<DriverEarningAdjustment>,
    private readonly commission: CommissionService,
    private readonly drivers: DriversService,
    config: ConfigService,
  ) {
    this.holdMs = Math.round(config.getOrThrow<number>("earningsHoldHours") * 3_600_000);
    this.timeZone = config.getOrThrow<string>("appTimeZone");
  }

  // ── Ledger writes ─────────────────────────────────────────────────────

  /**
   * Creates the ride's ledger line, or returns the existing one. Safe to call
   * any number of times for the same payment (verify + webhook + reconciler):
   * the unique indexes on rideId/paymentId make a second insert impossible.
   */
  async recordForPayment(input: RecordEarningInput): Promise<{ earning: DriverEarningDocument; created: boolean }> {
    const existing = await this.earningModel.findOne({ rideId: input.rideId }).exec();
    if (existing) return { earning: existing, created: false };

    // The rate in force now is captured on the line; later changes never touch it.
    const commission = await this.commission.effectiveAt(new Date());
    const split = splitFare(input.grossFarePaise, commission.value);
    const now = new Date();
    const cash = input.paymentMode === PaymentMode.CASH;
    // Cash is already in the driver's hand: nothing to hold or pay out.
    const status = cash ? EarningStatus.COLLECTED : this.holdMs > 0 ? EarningStatus.PENDING : EarningStatus.AVAILABLE;

    try {
      const earning = await this.earningModel.create({
        driverId: input.driverId,
        driverUserId: input.driverUserId,
        rideId: input.rideId,
        paymentId: input.paymentId,
        rideCode: input.rideCode,
        rideType: input.rideType,
        pickupAddress: input.pickupAddress,
        destinationAddress: input.destinationAddress,
        rideCompletedAt: input.rideCompletedAt,
        currency: input.currency,
        grossFarePaise: split.grossFarePaise,
        promoDiscountPaise: input.promoDiscountPaise ?? 0,
        commissionType: CommissionType.PERCENTAGE,
        commissionRate: split.commissionRate,
        commissionPaise: split.commissionPaise,
        netEarningPaise: split.netEarningPaise,
        commissionConfigId: commission._id,
        commissionVersion: commission.version,
        paymentMode: input.paymentMode,
        paymentMethod: input.paymentMethod,
        status,
        availableAt: cash ? now : new Date(now.getTime() + this.holdMs),
      });
      this.logger.log(
        `Earning for ride ${input.rideCode} (${input.paymentMode}): gross ${split.grossFarePaise}p, ` +
          `commission ${split.commissionRate}% = ${split.commissionPaise}p, driver ${split.netEarningPaise}p`,
      );
      return { earning, created: true };
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      // Lost a race with a concurrent verify/webhook: theirs is the line.
      const winner = await this.earningModel.findOne({ rideId: input.rideId }).exec();
      if (!winner) throw error;
      return { earning: winner, created: false };
    }
  }

  /**
   * A processed refund claws back the driver's share: one adjustment per
   * refund (unique), computed on the earning line's own snapshot. Safe to
   * call repeatedly for the same refund.
   */
  async recordRefundClawback(input: RefundClawbackInput): Promise<ClawbackOutcome> {
    const existing = await this.adjustmentModel.findOne({ refundId: input.refundId }).exec();
    if (existing) return { status: "RECORDED", adjustment: existing };

    const earning = await this.earningModel.findOne({ paymentId: input.paymentId }).exec();
    if (!earning) return { status: "NO_EARNING" };
    // The driver already holds a cash fare; Tirvona never refunds cash online.
    if ((earning.paymentMode ?? PaymentMode.ONLINE) === PaymentMode.CASH) return { status: "NOT_APPLICABLE" };

    const [previous] = await this.adjustmentModel
      .aggregate<{ gross: number; commission: number; refunds: number }>([
        { $match: { earningId: earning._id } },
        {
          $group: {
            _id: null,
            gross: { $sum: "$grossReversalPaise" },
            commission: { $sum: "$commissionReversalPaise" },
            refunds: { $sum: "$refundAmountPaise" },
          },
        },
      ])
      .exec();
    const clawback = refundClawback({
      earning,
      paidAmountPaise: input.paidAmountPaise,
      refundAmountPaise: input.refundAmountPaise,
      previousRefundsPaise: previous?.refunds ?? 0,
      previous: { grossPaise: previous?.gross ?? 0, commissionPaise: previous?.commission ?? 0 },
    });
    if (clawback.grossReversalPaise === 0 && clawback.amountPaise === 0) return { status: "NOT_APPLICABLE" };

    try {
      const adjustment = await this.adjustmentModel.create({
        driverId: earning.driverId,
        driverUserId: earning.driverUserId,
        earningId: earning._id,
        rideId: earning.rideId,
        paymentId: earning.paymentId,
        refundId: input.refundId,
        rideCode: earning.rideCode,
        type: AdjustmentType.REFUND_CLAWBACK,
        reason: input.reason,
        currency: earning.currency,
        refundAmountPaise: input.refundAmountPaise,
        grossReversalPaise: clawback.grossReversalPaise,
        commissionReversalPaise: clawback.commissionReversalPaise,
        amountPaise: clawback.amountPaise,
        commissionRate: earning.commissionRate,
        // Nothing to recover when the reversal is all commission.
        status: clawback.amountPaise > 0 ? AdjustmentStatus.OUTSTANDING : AdjustmentStatus.SETTLED,
        ...(clawback.amountPaise > 0 ? {} : { settledAt: new Date() }),
      });
      this.logger.log(
        `Refund clawback on ride ${earning.rideCode}: refund ${input.refundAmountPaise}p → driver −${clawback.amountPaise}p ` +
          `(gross ${clawback.grossReversalPaise}p, commission ${clawback.commissionReversalPaise}p)`,
      );
      return { status: "RECORDED", adjustment };
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      const winner = await this.adjustmentModel.findOne({ refundId: input.refundId }).exec();
      if (!winner) throw error;
      return { status: "RECORDED", adjustment: winner };
    }
  }

  /** OUTSTANDING deductions per driver (paise). */
  async outstandingDeductions(driverIds?: Types.ObjectId[]): Promise<Map<string, number>> {
    const rows = await this.adjustmentModel
      .aggregate<{ _id: Types.ObjectId; amount: number }>([
        { $match: { status: AdjustmentStatus.OUTSTANDING, ...(driverIds ? { driverId: { $in: driverIds } } : {}) } },
        { $group: { _id: "$driverId", amount: { $sum: "$amountPaise" } } },
      ])
      .exec();
    return new Map(rows.map((row) => [row._id.toString(), row.amount]));
  }

  async totalOutstandingDeductions(): Promise<number> {
    const totals = await this.outstandingDeductions();
    return [...totals.values()].reduce((sum, amount) => sum + amount, 0);
  }

  async adjustmentsForDriver(driverId: Types.ObjectId, limit = 50): Promise<AdjustmentView[]> {
    const rows = await this.adjustmentModel.find({ driverId }).sort({ createdAt: -1, _id: -1 }).limit(limit).exec();
    return rows.map((row) => this.toAdjustmentView(row));
  }

  async adjustmentsForPayment(paymentId: Types.ObjectId): Promise<AdjustmentView[]> {
    const rows = await this.adjustmentModel.find({ paymentId }).sort({ createdAt: 1 }).exec();
    return rows.map((row) => this.toAdjustmentView(row));
  }

  toAdjustmentView(adjustment: DriverEarningAdjustmentDocument): AdjustmentView {
    return {
      id: adjustment._id.toString(),
      type: adjustment.type,
      earningId: adjustment.earningId.toString(),
      rideId: adjustment.rideId.toString(),
      rideCode: adjustment.rideCode,
      paymentId: adjustment.paymentId.toString(),
      refundId: adjustment.refundId.toString(),
      reason: adjustment.reason,
      currency: adjustment.currency,
      refundAmount: toRupees(adjustment.refundAmountPaise),
      grossReversal: toRupees(adjustment.grossReversalPaise),
      commissionReversal: toRupees(adjustment.commissionReversalPaise),
      amount: toRupees(adjustment.amountPaise),
      commissionRate: adjustment.commissionRate,
      status: adjustment.status,
      payoutId: adjustment.payoutId?.toString(),
      settledAt: adjustment.settledAt,
      waiverNote: adjustment.waiverNote,
      createdAt: adjustment.get("createdAt") as Date,
    };
  }

  async findForPayment(paymentId: Types.ObjectId): Promise<EarningView | null> {
    const earning = await this.earningModel.findOne({ paymentId }).exec();
    return earning ? this.toView(earning) : null;
  }

  /** End of the settlement window: PENDING → AVAILABLE. Idempotent. */
  async promoteMatured(now: Date = new Date()): Promise<number> {
    const result = await this.earningModel
      .updateMany(
        { status: EarningStatus.PENDING, availableAt: { $lte: now } },
        { $set: { status: EarningStatus.AVAILABLE } },
      )
      .exec();
    return result.modifiedCount;
  }

  // ── Driver reads ──────────────────────────────────────────────────────

  async forDriver(driverUserId: string, query: DriverEarningsQueryDto): Promise<DriverEarningsResponse> {
    const driver = await this.drivers.getByUserId(driverUserId);
    await this.promoteMatured();

    const since = this.periodStart(query.period);
    const filter: QueryFilter<DriverEarning> = { driverId: driver._id };
    if (since) filter.rideCompletedAt = { $gte: since };
    if (query.status) filter.status = query.status;

    const [items, total, periodTotals, summary, adjustments] = await Promise.all([
      this.earningModel
        .find(filter)
        .sort({ rideCompletedAt: -1, _id: -1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .exec(),
      this.earningModel.countDocuments(filter).exec(),
      this.earningModel.aggregate<WindowTotals>([{ $match: filter }, { $group: LEDGER_TOTALS }]).exec(),
      this.summaryFor(driver._id, false),
      query.page === 1 ? this.adjustmentsForDriver(driver._id, 20) : Promise.resolve([]),
    ]);
    return {
      period: query.period,
      adjustments,
      periodTotals: toWindow(periodTotals[0]),
      summary,
      items: items.map((earning) => this.toView(earning)),
      page: query.page,
      limit: query.limit,
      total,
      hasMore: query.page * query.limit < total,
    };
  }

  async detailForDriver(driverUserId: string, earningId: string): Promise<EarningView> {
    const driver = await this.drivers.getByUserId(driverUserId);
    await this.promoteMatured();
    const earning = await this.earningModel.findOne({ _id: earningId, driverId: driver._id }).exec();
    if (!earning) throw apiNotFound("Earning not found", "EARNING_NOT_FOUND");
    const adjustments = await this.adjustmentModel.find({ earningId: earning._id }).sort({ createdAt: 1 }).exec();
    return { ...this.toView(earning), adjustments: adjustments.map((adjustment) => this.toAdjustmentView(adjustment)) };
  }

  /** Today / this week / this month / all time, plus payout balances. */
  async summaryFor(driverId: Types.ObjectId, promote = true): Promise<EarningsSummary> {
    if (promote) await this.promoteMatured();
    const now = new Date();
    const [result] = await this.earningModel
      .aggregate<{
        balances: StatusTotalsRow[];
        today: WindowTotals[];
        week: WindowTotals[];
        month: WindowTotals[];
        total: WindowTotals[];
      }>([
        { $match: { driverId } },
        {
          $facet: {
            balances: [{ $group: STATUS_TOTALS }],
            today: this.windowStages(startOfDayInTimeZone(now, this.timeZone)),
            week: this.windowStages(startOfWeekInTimeZone(now, this.timeZone)),
            month: this.windowStages(startOfMonthInTimeZone(now, this.timeZone)),
            total: [{ $group: LEDGER_TOTALS }],
          },
        },
      ])
      .exec();
    const deductions = (await this.outstandingDeductions([driverId])).get(driverId.toString()) ?? 0;
    return {
      currency: "INR",
      today: toWindow(result?.today[0]),
      week: toWindow(result?.week[0]),
      month: toWindow(result?.month[0]),
      total: toWindow(result?.total[0]),
      balances: this.balancesFrom(result?.balances ?? [], deductions),
    };
  }

  /** Today's totals for the driver dashboard card. */
  async todayFor(driverId: Types.ObjectId): Promise<EarningsWindow> {
    const [totals] = await this.earningModel
      .aggregate<WindowTotals>([
        { $match: { driverId, rideCompletedAt: { $gte: startOfDayInTimeZone(new Date(), this.timeZone) } } },
        { $group: LEDGER_TOTALS },
      ])
      .exec();
    return toWindow(totals);
  }

  // ── Mapping ───────────────────────────────────────────────────────────

  toView(earning: DriverEarningDocument): EarningView {
    return {
      id: earning._id.toString(),
      rideId: earning.rideId.toString(),
      rideCode: earning.rideCode,
      rideType: earning.rideType,
      paymentId: earning.paymentId.toString(),
      pickupAddress: earning.pickupAddress,
      destinationAddress: earning.destinationAddress,
      rideCompletedAt: earning.rideCompletedAt,
      currency: earning.currency,
      grossFare: toRupees(earning.grossFarePaise),
      promoDiscount: toRupees(earning.promoDiscountPaise ?? 0),
      commissionType: earning.commissionType,
      commissionRate: earning.commissionRate,
      commissionAmount: toRupees(earning.commissionPaise),
      netEarning: toRupees(earning.netEarningPaise),
      paymentMode: earning.paymentMode ?? PaymentMode.ONLINE,
      paymentMethod: earning.paymentMethod,
      status: earning.status,
      availableAt: earning.availableAt,
      payoutId: earning.payoutId?.toString(),
      paidAt: earning.paidAt,
      payoutReference: earning.payoutReference,
      payoutNote: earning.payoutNote,
      createdAt: earning.get("createdAt") as Date,
    };
  }

  balancesFrom(rows: StatusTotalsRow[], deductionsPaise = 0): EarningsBalances {
    const row = (status: EarningStatus) => rows.find((candidate) => candidate._id === status);
    const of = (status: EarningStatus): number => toRupees(row(status)?.amount ?? 0);
    return {
      pending: of(EarningStatus.PENDING),
      available: of(EarningStatus.AVAILABLE),
      paid: of(EarningStatus.PAID),
      collected: of(EarningStatus.COLLECTED),
      // On a cash ride with a promo the driver collected fare − discount, so
      // the platform owes the discount back: it is netted against commission
      // (negative = Tirvona owes the driver).
      commissionDue: toRupees((row(EarningStatus.COLLECTED)?.commission ?? 0) - (row(EarningStatus.COLLECTED)?.discount ?? 0)),
      // Refund clawbacks still to be deducted from the next payout.
      deductions: toRupees(deductionsPaise),
    };
  }

  private windowStages(since: Date): PipelineStage.FacetPipelineStage[] {
    return [{ $match: { rideCompletedAt: { $gte: since } } }, { $group: LEDGER_TOTALS }];
  }

  private periodStart(period: EarningsPeriod): Date | undefined {
    const now = new Date();
    switch (period) {
      case EarningsPeriod.TODAY:
        return startOfDayInTimeZone(now, this.timeZone);
      case EarningsPeriod.WEEK:
        return startOfWeekInTimeZone(now, this.timeZone);
      case EarningsPeriod.MONTH:
        return startOfMonthInTimeZone(now, this.timeZone);
      case EarningsPeriod.ALL:
        return undefined;
    }
  }
}
