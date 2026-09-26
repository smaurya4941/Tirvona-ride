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
import { splitFare } from "./commission";
import { CommissionService } from "./commission.service";
import type { DriverEarningsQueryDto } from "./dto/earnings-query.dto";
import { CommissionType, EarningStatus, EarningsPeriod, PaymentMode } from "./interfaces/earning-status";
import type {
  DriverEarningsResponse,
  EarningView,
  EarningsBalances,
  EarningsSummary,
  EarningsWindow,
} from "./interfaces/earning-views";
import { DriverEarning } from "./schemas/driver-earning.schema";
import type { DriverEarningDocument } from "./schemas/driver-earning.schema";

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
  currency: string;
  paymentMode: PaymentMode;
  paymentMethod?: string;
}

/** Ledger lines grouped by status: the driver's share and Tirvona's commission (paise). */
export interface StatusTotalsRow {
  _id: EarningStatus;
  amount: number;
  commission: number;
}

/** `$group` stage producing StatusTotalsRow. */
export const STATUS_TOTALS = {
  _id: "$status",
  amount: { $sum: "$netEarningPaise" },
  commission: { $sum: "$commissionPaise" },
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

    const [items, total, periodTotals, summary] = await Promise.all([
      this.earningModel
        .find(filter)
        .sort({ rideCompletedAt: -1, _id: -1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .exec(),
      this.earningModel.countDocuments(filter).exec(),
      this.earningModel.aggregate<WindowTotals>([{ $match: filter }, { $group: LEDGER_TOTALS }]).exec(),
      this.summaryFor(driver._id, false),
    ]);
    return {
      period: query.period,
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
    return this.toView(earning);
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
    return {
      currency: "INR",
      today: toWindow(result?.today[0]),
      week: toWindow(result?.week[0]),
      month: toWindow(result?.month[0]),
      total: toWindow(result?.total[0]),
      balances: this.balancesFrom(result?.balances ?? []),
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

  balancesFrom(rows: StatusTotalsRow[]): EarningsBalances {
    const row = (status: EarningStatus) => rows.find((candidate) => candidate._id === status);
    const of = (status: EarningStatus): number => toRupees(row(status)?.amount ?? 0);
    return {
      pending: of(EarningStatus.PENDING),
      available: of(EarningStatus.AVAILABLE),
      paid: of(EarningStatus.PAID),
      collected: of(EarningStatus.COLLECTED),
      commissionDue: toRupees(row(EarningStatus.COLLECTED)?.commission ?? 0),
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
