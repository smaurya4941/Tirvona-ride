import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectModel } from "@nestjs/mongoose";
import type { Model, PipelineStage } from "mongoose";
import { apiBadRequest } from "../../common/exceptions/api.exception";
import { UserRole } from "../../common/types/user-role.enum";
import { toRupees } from "../../common/utils/money";
import {
  Cancellation,
  CancellationFeeStatus,
} from "../cancellations/schemas/cancellation.schemas";
import {
  DriverProfile,
  DriverStatus,
} from "../drivers/schemas/driver-profile.schema";
import { PaymentMode } from "../earnings/interfaces/earning-status";
import { DriverEarning } from "../earnings/schemas/driver-earning.schema";
import {
  PaymentGateway,
  PaymentStatus,
} from "../payments/interfaces/payment-status";
import { Payment } from "../payments/schemas/payment.schema";
import { PromoStatus } from "../promotions/promo-rules";
import {
  PromoCode,
  PromoRedemption,
  PromoRedemptionStatus,
} from "../promotions/schemas/promo-code.schema";
import { RideActorType, RideStatus } from "../rides/ride-state-machine";
import { Ride } from "../rides/schemas/ride.schema";
import { User, UserStatus } from "../users/schemas/user.schema";
import {
  ReportPreset,
  ReportRangeError,
  fillDays,
  ratio,
  resolveReportRange,
  round2,
} from "./report-range";
import type { ReportRange } from "./report-range";

// ── Report shapes ───────────────────────────────────────────────────────

export interface RangeView {
  preset: ReportPreset;
  from: Date;
  to: Date;
  days: number;
  timeZone: string;
}

export interface OverviewReport {
  range: RangeView;
  rides: {
    requested: number;
    completed: number;
    cancelled: number;
    noDriver: number;
    activeNow: number;
  };
  customers: { total: number; new: number };
  drivers: {
    approved: number;
    pendingKyc: number;
    onlineNow: number;
    availableNow: number;
  };
  money: {
    completedRideValue: number;
    promoDiscounts: number;
    collected: number;
    driverEarnings: number;
    platformCommission: number;
    cancellationFees: number;
  };
}

export interface BreakdownRow {
  key: string;
  label: string;
  requested: number;
  completed: number;
  cancelled: number;
  completedValue: number;
}

export interface RidesReport {
  range: RangeView;
  /** Rides *requested* in the range, by where they ended up (cohort view). */
  totals: {
    requested: number;
    searching: number;
    assigned: number;
    inProgress: number;
    completed: number;
    cancelled: number;
    noDriver: number;
    completionRate: number;
    cancellationRate: number;
  };
  averages: {
    fare: number;
    distanceKm: number;
    durationMinutes: number;
    tripMinutes: number;
  };
  byRideType: BreakdownRow[];
  byZone: BreakdownRow[];
  byDay: Array<{
    date: string;
    requested: number;
    completed: number;
    cancelled: number;
  }>;
}

export interface RevenueReport {
  range: RangeView;
  totals: {
    /** Σ estimated fare of rides requested in the range (demand). */
    grossBookedValue: number;
    /** Σ final fare of rides completed in the range. */
    completedRideValue: number;
    promoDiscounts: number;
    /** completedRideValue − promoDiscounts: what customers owe for those trips. */
    customerPayable: number;
    collectedOnline: number;
    collectedCash: number;
    collected: number;
    refunds: number;
    cancellationFeesAssessed: number;
    cancellationFeesCollected: number;
    cancellationFeesWaived: number;
    cancellationFeesDue: number;
    driverEarnings: number;
    platformCommission: number;
    /** Commission less platform-funded promo discounts. */
    platformNetRevenue: number;
    unpaidCompletedRides: number;
    unpaidAmount: number;
  };
  byDay: Array<{
    date: string;
    completedValue: number;
    collected: number;
    commission: number;
    discounts: number;
  }>;
}

export interface DriversReport {
  range: RangeView;
  totals: {
    total: number;
    pendingKyc: number;
    underReview: number;
    approved: number;
    rejected: number;
    suspended: number;
    online: number;
    available: number;
    activeInRange: number;
  };
  top: Array<{
    driverId: string;
    driverCode: string;
    name: string;
    completedRides: number;
    cancelledRides: number;
    completedValue: number;
    netEarnings: number;
    ratingAverage: number;
    ratingCount: number;
  }>;
}

export interface CustomersReport {
  range: RangeView;
  totals: {
    total: number;
    new: number;
    active: number;
    bookings: number;
    completedRides: number;
    cancelledRides: number;
    averageRidesPerActiveCustomer: number;
    blocked: number;
  };
  byDay: Array<{ date: string; newCustomers: number; activeCustomers: number }>;
}

export interface CancellationsReport {
  range: RangeView;
  totals: {
    total: number;
    byCustomer: number;
    byDriver: number;
    byAdmin: number;
    /** Search windows that found no driver (system outcome, not a cancel action). */
    noDriverExpiries: number;
    cancellationRate: number;
  };
  fees: {
    assessed: number;
    due: number;
    collected: number;
    waived: number;
    charged: number;
  };
  byReason: Array<{
    actor: RideActorType;
    code: string;
    label: string;
    count: number;
  }>;
  byStatusAtCancellation: Array<{ status: RideStatus; count: number }>;
  byDay: Array<{
    date: string;
    customer: number;
    driver: number;
    admin: number;
  }>;
}

export interface PromotionsReport {
  range: RangeView;
  totals: {
    promos: number;
    activePromos: number;
    liveNow: number;
    applied: number;
    redeemed: number;
    released: number;
    discountGiven: number;
    promoAssistedRides: number;
    promoAssistedValue: number;
  };
  top: Array<{
    code: string;
    title: string;
    redeemed: number;
    discount: number;
    applied: number;
  }>;
}

type CountRow = { _id: string; count: number };
const sumOf = (rows: CountRow[], keys: readonly string[]): number =>
  rows
    .filter((row) => keys.includes(row._id))
    .reduce((total, row) => total + row.count, 0);
const nameOf = (
  user?: { firstName?: string; lastName?: string } | null,
): string => [user?.firstName, user?.lastName].filter(Boolean).join(" ");

/**
 * Read-only analytics over the operational collections. Every figure is an
 * aggregation of the underlying records (no separately-maintained counters),
 * so dashboard totals always reconcile with the rides, payments, earnings
 * and cancellations they summarise. Money is returned in rupees.
 */
@Injectable()
export class ReportsService {
  private readonly timeZone: string;
  private readonly maxRangeDays: number;

  constructor(
    @InjectModel(Ride.name) private readonly rideModel: Model<Ride>,
    @InjectModel(User.name) private readonly userModel: Model<User>,
    @InjectModel(DriverProfile.name)
    private readonly driverModel: Model<DriverProfile>,
    @InjectModel(Payment.name) private readonly paymentModel: Model<Payment>,
    @InjectModel(DriverEarning.name)
    private readonly earningModel: Model<DriverEarning>,
    @InjectModel(Cancellation.name)
    private readonly cancellationModel: Model<Cancellation>,
    @InjectModel(PromoCode.name) private readonly promoModel: Model<PromoCode>,
    @InjectModel(PromoRedemption.name)
    private readonly redemptionModel: Model<PromoRedemption>,
    config: ConfigService,
  ) {
    this.timeZone = config.getOrThrow<string>("appTimeZone");
    this.maxRangeDays = config.getOrThrow<number>("reportMaxRangeDays");
  }

  range(
    input: { preset?: ReportPreset; from?: string; to?: string },
    now = new Date(),
  ): ReportRange {
    try {
      return resolveReportRange(input, now, this.timeZone, this.maxRangeDays);
    } catch (error) {
      if (error instanceof ReportRangeError)
        throw apiBadRequest(error.message, "REPORT_RANGE_INVALID");
      throw error;
    }
  }

  // ── Overview ──────────────────────────────────────────────────────────

  async overview(range: ReportRange): Promise<OverviewReport> {
    const window = { $gte: range.from, $lt: range.to };
    const [
      rides,
      customers,
      newCustomers,
      driverCounts,
      online,
      available,
      money,
      collected,
      earnings,
      fees,
      activeNow,
    ] = await Promise.all([
      this.rideModel
        .aggregate<{
          requested: number;
          completed: number;
          cancelled: number;
          noDriver: number;
        }>([
          {
            $facet: {
              requested: [{ $match: { requestedAt: window } }, { $count: "n" }],
              completed: [
                {
                  $match: { status: RideStatus.COMPLETED, completedAt: window },
                },
                { $count: "n" },
              ],
              cancelled: [
                {
                  $match: { status: RideStatus.CANCELLED, cancelledAt: window },
                },
                { $count: "n" },
              ],
              noDriver: [
                {
                  $match: {
                    status: RideStatus.NO_DRIVER_AVAILABLE,
                    expiredAt: window,
                  },
                },
                { $count: "n" },
              ],
            },
          },
          {
            $project: {
              requested: { $ifNull: [{ $first: "$requested.n" }, 0] },
              completed: { $ifNull: [{ $first: "$completed.n" }, 0] },
              cancelled: { $ifNull: [{ $first: "$cancelled.n" }, 0] },
              noDriver: { $ifNull: [{ $first: "$noDriver.n" }, 0] },
            },
          },
        ])
        .exec(),
      this.userModel.countDocuments({ role: UserRole.CUSTOMER }).exec(),
      this.userModel
        .countDocuments({ role: UserRole.CUSTOMER, createdAt: window })
        .exec(),
      this.driverModel
        .aggregate<CountRow>([
          { $group: { _id: "$driverStatus", count: { $sum: 1 } } },
        ])
        .exec(),
      this.driverModel
        .countDocuments({ isOnline: true, driverStatus: DriverStatus.APPROVED })
        .exec(),
      this.driverModel
        .countDocuments({
          isOnline: true,
          isAvailable: true,
          driverStatus: DriverStatus.APPROVED,
        })
        .exec(),
      this.completedValue(range),
      this.collected(range),
      this.earningsTotals(range),
      this.feeTotals(range),
      this.rideModel.countDocuments({ isActive: true }).exec(),
    ]);
    const r = rides[0] ?? {
      requested: 0,
      completed: 0,
      cancelled: 0,
      noDriver: 0,
    };
    return {
      range: this.rangeView(range),
      rides: { ...r, activeNow },
      customers: { total: customers, new: newCustomers },
      drivers: {
        approved: sumOf(driverCounts, [DriverStatus.APPROVED]),
        pendingKyc: sumOf(driverCounts, [
          DriverStatus.PENDING,
          DriverStatus.UNDER_REVIEW,
        ]),
        onlineNow: online,
        availableNow: available,
      },
      money: {
        completedRideValue: money.value,
        promoDiscounts: money.discounts,
        collected: round2(collected.online + collected.cash),
        driverEarnings: earnings.net,
        platformCommission: earnings.commission,
        cancellationFees: round2(fees.due + fees.collected),
      },
    };
  }

  // ── Rides ─────────────────────────────────────────────────────────────

  async rides(range: ReportRange): Promise<RidesReport> {
    const cohort: PipelineStage.Match = {
      $match: { requestedAt: { $gte: range.from, $lt: range.to } },
    };
    const outcome = {
      requested: { $sum: 1 },
      completed: {
        $sum: { $cond: [{ $eq: ["$status", RideStatus.COMPLETED] }, 1, 0] },
      },
      cancelled: {
        $sum: { $cond: [{ $eq: ["$status", RideStatus.CANCELLED] }, 1, 0] },
      },
      completedValue: {
        $sum: {
          $cond: [
            { $eq: ["$status", RideStatus.COMPLETED] },
            { $ifNull: ["$fare.finalFare", 0] },
            0,
          ],
        },
      },
    };
    const [result] = await this.rideModel
      .aggregate<{
        byStatus: CountRow[];
        averages: Array<{
          fare: number;
          distance: number;
          duration: number;
          trip: number;
        }>;
        byType: Array<{ _id: string } & Omit<BreakdownRow, "key" | "label">>;
        byZone: Array<
          { _id: { id: string | null; name: string | null } } & Omit<
            BreakdownRow,
            "key" | "label"
          >
        >;
        byDay: Array<{
          _id: string;
          requested: number;
          completed: number;
          cancelled: number;
        }>;
      }>([
        cohort,
        {
          $facet: {
            byStatus: [{ $group: { _id: "$status", count: { $sum: 1 } } }],
            averages: [
              { $match: { status: RideStatus.COMPLETED } },
              {
                $group: {
                  _id: null,
                  fare: { $avg: "$fare.finalFare" },
                  distance: { $avg: "$distanceMeters" },
                  duration: { $avg: "$durationSeconds" },
                  trip: {
                    $avg: {
                      $dateDiff: {
                        startDate: "$startedAt",
                        endDate: "$completedAt",
                        unit: "second",
                      },
                    },
                  },
                },
              },
            ],
            byType: [
              { $group: { _id: "$rideType", ...outcome } },
              { $sort: { requested: -1 } },
            ],
            byZone: [
              {
                $group: {
                  _id: { id: "$zoneId", name: "$zoneName" },
                  ...outcome,
                },
              },
              { $sort: { requested: -1 } },
            ],
            byDay: [
              {
                $group: {
                  _id: {
                    $dateToString: {
                      format: "%Y-%m-%d",
                      date: "$requestedAt",
                      timezone: range.timeZone,
                    },
                  },
                  requested: outcome.requested,
                  completed: outcome.completed,
                  cancelled: outcome.cancelled,
                },
              },
            ],
          },
        },
      ])
      .exec();

    const requested = result.byStatus.reduce(
      (total, row) => total + row.count,
      0,
    );
    const completed = sumOf(result.byStatus, [RideStatus.COMPLETED]);
    const cancelled = sumOf(result.byStatus, [RideStatus.CANCELLED]);
    const averages = result.averages[0];
    const breakdown = (
      key: string,
      label: string,
      row: Omit<BreakdownRow, "key" | "label">,
    ): BreakdownRow => ({
      key,
      label,
      requested: row.requested,
      completed: row.completed,
      cancelled: row.cancelled,
      completedValue: round2(row.completedValue),
    });

    return {
      range: this.rangeView(range),
      totals: {
        requested,
        searching: sumOf(result.byStatus, [RideStatus.SEARCHING]),
        assigned: sumOf(result.byStatus, [RideStatus.DRIVER_ASSIGNED]),
        inProgress: sumOf(result.byStatus, [
          RideStatus.DRIVER_ACCEPTED,
          RideStatus.DRIVER_ARRIVED,
          RideStatus.RIDE_STARTED,
        ]),
        completed,
        cancelled,
        noDriver: sumOf(result.byStatus, [RideStatus.NO_DRIVER_AVAILABLE]),
        completionRate: ratio(completed, requested),
        cancellationRate: ratio(cancelled, requested),
      },
      averages: {
        fare: round2(averages?.fare ?? 0),
        distanceKm: round2((averages?.distance ?? 0) / 1000),
        durationMinutes: round2((averages?.duration ?? 0) / 60),
        tripMinutes: round2((averages?.trip ?? 0) / 60),
      },
      byRideType: result.byType.map((row) => breakdown(row._id, row._id, row)),
      byZone: result.byZone.map((row) =>
        breakdown(
          row._id.id?.toString() ?? "NONE",
          row._id.name ?? "Outside zones / before zones",
          row,
        ),
      ),
      byDay: fillDays(range.days, result.byDay, {
        requested: 0,
        completed: 0,
        cancelled: 0,
      }),
    };
  }

  // ── Revenue ───────────────────────────────────────────────────────────

  async revenue(range: ReportRange): Promise<RevenueReport> {
    const window = { $gte: range.from, $lt: range.to };
    const tz = range.timeZone;
    const [
      booked,
      value,
      collected,
      refunds,
      fees,
      earnings,
      unpaid,
      valueByDay,
      collectedByDay,
      commissionByDay,
    ] = await Promise.all([
      this.rideModel
        .aggregate<{ total: number }>([
          { $match: { requestedAt: window } },
          { $group: { _id: null, total: { $sum: "$fare.estimatedFare" } } },
        ])
        .exec(),
      this.completedValue(range),
      this.collected(range),
      this.paymentModel
        .aggregate<{ total: number }>([
          { $match: { refundedAt: window, refundAmountPaise: { $gt: 0 } } },
          { $group: { _id: null, total: { $sum: "$refundAmountPaise" } } },
        ])
        .exec(),
      this.feeTotals(range),
      this.earningsTotals(range),
      this.rideModel
        .aggregate<{ rides: number; amount: number }>([
          {
            $match: {
              status: RideStatus.COMPLETED,
              completedAt: window,
              paymentStatus: {
                $in: ["PENDING", "ORDER_CREATED", "PROCESSING", "FAILED"],
              },
            },
          },
          {
            $group: {
              _id: null,
              rides: { $sum: 1 },
              amount: {
                $sum: { $ifNull: ["$fare.payableFare", "$fare.finalFare"] },
              },
            },
          },
        ])
        .exec(),
      this.rideModel
        .aggregate<{ _id: string; completedValue: number; discounts: number }>([
          { $match: { status: RideStatus.COMPLETED, completedAt: window } },
          {
            $group: {
              _id: {
                $dateToString: {
                  format: "%Y-%m-%d",
                  date: "$completedAt",
                  timezone: tz,
                },
              },
              completedValue: { $sum: { $ifNull: ["$fare.finalFare", 0] } },
              discounts: { $sum: { $ifNull: ["$fare.discount", 0] } },
            },
          },
        ])
        .exec(),
      this.paymentModel
        .aggregate<{ _id: string; collected: number }>([
          {
            $match: {
              paidAt: window,
              status: { $in: this.settledPaymentStatuses() },
            },
          },
          {
            $group: {
              _id: {
                $dateToString: {
                  format: "%Y-%m-%d",
                  date: "$paidAt",
                  timezone: tz,
                },
              },
              collected: { $sum: { $divide: ["$amountPaise", 100] } },
            },
          },
        ])
        .exec(),
      this.earningModel
        .aggregate<{ _id: string; commission: number }>([
          { $match: { rideCompletedAt: window } },
          {
            $group: {
              _id: {
                $dateToString: {
                  format: "%Y-%m-%d",
                  date: "$rideCompletedAt",
                  timezone: tz,
                },
              },
              commission: { $sum: { $divide: ["$commissionPaise", 100] } },
            },
          },
        ])
        .exec(),
    ]);

    const byDay = new Map<
      string,
      {
        completedValue: number;
        collected: number;
        commission: number;
        discounts: number;
      }
    >();
    const bucket = (date: string) => {
      if (!byDay.has(date))
        byDay.set(date, {
          completedValue: 0,
          collected: 0,
          commission: 0,
          discounts: 0,
        });
      return byDay.get(date)!;
    };
    for (const row of valueByDay)
      Object.assign(bucket(row._id), {
        completedValue: row.completedValue,
        discounts: row.discounts,
      });
    for (const row of collectedByDay) bucket(row._id).collected = row.collected;
    for (const row of commissionByDay)
      bucket(row._id).commission = row.commission;

    return {
      range: this.rangeView(range),
      totals: {
        grossBookedValue: round2(booked[0]?.total ?? 0),
        completedRideValue: value.value,
        promoDiscounts: value.discounts,
        customerPayable: round2(value.value - value.discounts),
        collectedOnline: collected.online,
        collectedCash: collected.cash,
        collected: round2(collected.online + collected.cash),
        refunds: toRupees(refunds[0]?.total ?? 0),
        cancellationFeesAssessed: round2(
          fees.due + fees.collected + fees.waived,
        ),
        cancellationFeesCollected: fees.collected,
        cancellationFeesWaived: fees.waived,
        cancellationFeesDue: fees.due,
        driverEarnings: earnings.net,
        platformCommission: earnings.commission,
        platformNetRevenue: round2(earnings.commission - earnings.discounts),
        unpaidCompletedRides: unpaid[0]?.rides ?? 0,
        unpaidAmount: round2(unpaid[0]?.amount ?? 0),
      },
      byDay: range.days.map((date) => {
        const row = byDay.get(date);
        return {
          date,
          completedValue: round2(row?.completedValue ?? 0),
          collected: round2(row?.collected ?? 0),
          commission: round2(row?.commission ?? 0),
          discounts: round2(row?.discounts ?? 0),
        };
      }),
    };
  }

  // ── Drivers ───────────────────────────────────────────────────────────

  async drivers(range: ReportRange): Promise<DriversReport> {
    const window = { $gte: range.from, $lt: range.to };
    const [statusRows, online, available, perDriver, earnings] =
      await Promise.all([
        this.driverModel
          .aggregate<CountRow>([
            { $group: { _id: "$driverStatus", count: { $sum: 1 } } },
          ])
          .exec(),
        this.driverModel
          .countDocuments({
            isOnline: true,
            driverStatus: DriverStatus.APPROVED,
          })
          .exec(),
        this.driverModel
          .countDocuments({
            isOnline: true,
            isAvailable: true,
            driverStatus: DriverStatus.APPROVED,
          })
          .exec(),
        this.rideModel
          .aggregate<{
            _id: string;
            completed: number;
            cancelled: number;
            completedValue: number;
          }>([
            {
              $match: {
                driverId: { $exists: true },
                $or: [
                  { status: RideStatus.COMPLETED, completedAt: window },
                  {
                    status: RideStatus.CANCELLED,
                    cancelledAt: window,
                    "cancellation.cancelledBy": RideActorType.DRIVER,
                  },
                ],
              },
            },
            {
              $group: {
                _id: "$driverId",
                completed: {
                  $sum: {
                    $cond: [{ $eq: ["$status", RideStatus.COMPLETED] }, 1, 0],
                  },
                },
                cancelled: {
                  $sum: {
                    $cond: [{ $eq: ["$status", RideStatus.CANCELLED] }, 1, 0],
                  },
                },
                completedValue: {
                  $sum: {
                    $cond: [
                      { $eq: ["$status", RideStatus.COMPLETED] },
                      { $ifNull: ["$fare.finalFare", 0] },
                      0,
                    ],
                  },
                },
              },
            },
            { $sort: { completed: -1, completedValue: -1 } },
            { $limit: 25 },
          ])
          .exec(),
        this.earningModel
          .aggregate<{ _id: string; net: number }>([
            { $match: { rideCompletedAt: window } },
            { $group: { _id: "$driverId", net: { $sum: "$netEarningPaise" } } },
          ])
          .exec(),
      ]);
    const profiles = await this.driverModel
      .find({ _id: { $in: perDriver.map((row) => row._id) } })
      .select("driverCode userId ratingAverage ratingCount")
      .lean()
      .exec();
    const users = await this.userModel
      .find({ _id: { $in: profiles.map((profile) => profile.userId) } })
      .select("firstName lastName")
      .lean()
      .exec();
    const profileById = new Map(
      profiles.map((profile) => [profile._id.toString(), profile]),
    );
    const userById = new Map(users.map((user) => [user._id.toString(), user]));
    const netById = new Map(
      earnings.map((row) => [row._id.toString(), row.net]),
    );
    const activeInRange = await this.rideModel
      .distinct("driverId", {
        status: RideStatus.COMPLETED,
        completedAt: window,
      })
      .exec();

    return {
      range: this.rangeView(range),
      totals: {
        total: statusRows.reduce((total, row) => total + row.count, 0),
        pendingKyc: sumOf(statusRows, [DriverStatus.PENDING]),
        underReview: sumOf(statusRows, [DriverStatus.UNDER_REVIEW]),
        approved: sumOf(statusRows, [DriverStatus.APPROVED]),
        rejected: sumOf(statusRows, [DriverStatus.REJECTED]),
        suspended: sumOf(statusRows, [DriverStatus.SUSPENDED]),
        online,
        available,
        activeInRange: activeInRange.length,
      },
      top: perDriver.map((row) => {
        const profile = profileById.get(row._id.toString());
        return {
          driverId: row._id.toString(),
          driverCode: profile?.driverCode ?? "—",
          name:
            nameOf(profile ? userById.get(profile.userId.toString()) : null) ||
            "Unknown driver",
          completedRides: row.completed,
          cancelledRides: row.cancelled,
          completedValue: round2(row.completedValue),
          netEarnings: toRupees(netById.get(row._id.toString()) ?? 0),
          ratingAverage: profile?.ratingAverage ?? 0,
          ratingCount: profile?.ratingCount ?? 0,
        };
      }),
    };
  }

  // ── Customers ─────────────────────────────────────────────────────────

  async customers(range: ReportRange): Promise<CustomersReport> {
    const window = { $gte: range.from, $lt: range.to };
    const tz = range.timeZone;
    const [total, fresh, blocked, rideStats, newByDay, activeByDay] =
      await Promise.all([
        this.userModel.countDocuments({ role: UserRole.CUSTOMER }).exec(),
        this.userModel
          .countDocuments({ role: UserRole.CUSTOMER, createdAt: window })
          .exec(),
        this.userModel
          .countDocuments({
            role: UserRole.CUSTOMER,
            status: UserStatus.BLOCKED,
          })
          .exec(),
        this.rideModel
          .aggregate<{
            active: number;
            bookings: number;
            completed: number;
            cancelled: number;
          }>([
            { $match: { requestedAt: window } },
            {
              $group: {
                _id: "$customerId",
                bookings: { $sum: 1 },
                completed: {
                  $sum: {
                    $cond: [{ $eq: ["$status", RideStatus.COMPLETED] }, 1, 0],
                  },
                },
                cancelled: {
                  $sum: {
                    $cond: [{ $eq: ["$status", RideStatus.CANCELLED] }, 1, 0],
                  },
                },
              },
            },
            {
              $group: {
                _id: null,
                active: { $sum: 1 },
                bookings: { $sum: "$bookings" },
                completed: { $sum: "$completed" },
                cancelled: { $sum: "$cancelled" },
              },
            },
          ])
          .exec(),
        this.userModel
          .aggregate<{ _id: string; newCustomers: number }>([
            { $match: { role: UserRole.CUSTOMER, createdAt: window } },
            {
              $group: {
                _id: {
                  $dateToString: {
                    format: "%Y-%m-%d",
                    date: "$createdAt",
                    timezone: tz,
                  },
                },
                newCustomers: { $sum: 1 },
              },
            },
          ])
          .exec(),
        this.rideModel
          .aggregate<{ _id: string; activeCustomers: number }>([
            { $match: { requestedAt: window } },
            {
              $group: {
                _id: {
                  day: {
                    $dateToString: {
                      format: "%Y-%m-%d",
                      date: "$requestedAt",
                      timezone: tz,
                    },
                  },
                  customer: "$customerId",
                },
              },
            },
            { $group: { _id: "$_id.day", activeCustomers: { $sum: 1 } } },
          ])
          .exec(),
      ]);
    const stats = rideStats[0] ?? {
      active: 0,
      bookings: 0,
      completed: 0,
      cancelled: 0,
    };
    const active = new Map(
      activeByDay.map((row) => [row._id, row.activeCustomers]),
    );
    return {
      range: this.rangeView(range),
      totals: {
        total,
        new: fresh,
        active: stats.active,
        bookings: stats.bookings,
        completedRides: stats.completed,
        cancelledRides: stats.cancelled,
        averageRidesPerActiveCustomer: stats.active
          ? round2(stats.bookings / stats.active)
          : 0,
        blocked,
      },
      byDay: fillDays(range.days, newByDay, { newCustomers: 0 }).map((row) => ({
        ...row,
        activeCustomers: active.get(row.date) ?? 0,
      })),
    };
  }

  // ── Cancellations ─────────────────────────────────────────────────────

  async cancellations(range: ReportRange): Promise<CancellationsReport> {
    const window = { $gte: range.from, $lt: range.to };
    const [result] = await this.cancellationModel
      .aggregate<{
        byActor: CountRow[];
        byReason: Array<{
          _id: { actor: RideActorType; code: string };
          label: string;
          count: number;
        }>;
        byStatus: CountRow[];
        byDay: Array<{
          _id: string;
          customer: number;
          driver: number;
          admin: number;
        }>;
      }>([
        { $match: { cancelledAt: window } },
        {
          $facet: {
            byActor: [{ $group: { _id: "$cancelledBy", count: { $sum: 1 } } }],
            byReason: [
              {
                $group: {
                  _id: { actor: "$cancelledBy", code: "$reasonCode" },
                  label: { $last: "$reasonLabel" },
                  count: { $sum: 1 },
                },
              },
              { $sort: { count: -1 } },
            ],
            byStatus: [
              {
                $group: {
                  _id: "$rideStatusAtCancellation",
                  count: { $sum: 1 },
                },
              },
              { $sort: { count: -1 } },
            ],
            byDay: [
              {
                $group: {
                  _id: {
                    $dateToString: {
                      format: "%Y-%m-%d",
                      date: "$cancelledAt",
                      timezone: range.timeZone,
                    },
                  },
                  customer: {
                    $sum: {
                      $cond: [
                        { $eq: ["$cancelledBy", RideActorType.CUSTOMER] },
                        1,
                        0,
                      ],
                    },
                  },
                  driver: {
                    $sum: {
                      $cond: [
                        { $eq: ["$cancelledBy", RideActorType.DRIVER] },
                        1,
                        0,
                      ],
                    },
                  },
                  admin: {
                    $sum: {
                      $cond: [
                        { $eq: ["$cancelledBy", RideActorType.ADMIN] },
                        1,
                        0,
                      ],
                    },
                  },
                },
              },
            ],
          },
        },
      ])
      .exec();
    const [fees, noDriver, requested] = await Promise.all([
      this.feeTotals(range),
      this.rideModel
        .countDocuments({
          status: RideStatus.NO_DRIVER_AVAILABLE,
          expiredAt: window,
        })
        .exec(),
      this.rideModel.countDocuments({ requestedAt: window }).exec(),
    ]);
    const total = result.byActor.reduce((sum, row) => sum + row.count, 0);
    return {
      range: this.rangeView(range),
      totals: {
        total,
        byCustomer: sumOf(result.byActor, [RideActorType.CUSTOMER]),
        byDriver: sumOf(result.byActor, [RideActorType.DRIVER]),
        byAdmin: sumOf(result.byActor, [RideActorType.ADMIN]),
        noDriverExpiries: noDriver,
        cancellationRate: ratio(total, requested),
      },
      fees: {
        ...fees,
        assessed: round2(fees.due + fees.collected + fees.waived),
        charged: round2(fees.due + fees.collected),
      },
      byReason: result.byReason.map((row) => ({
        actor: row._id.actor,
        code: row._id.code,
        label: row.label,
        count: row.count,
      })),
      byStatusAtCancellation: result.byStatus.map((row) => ({
        status: row._id as RideStatus,
        count: row.count,
      })),
      byDay: fillDays(range.days, result.byDay, {
        customer: 0,
        driver: 0,
        admin: 0,
      }),
    };
  }

  // ── Promotions ────────────────────────────────────────────────────────

  async promotions(range: ReportRange): Promise<PromotionsReport> {
    const window = { $gte: range.from, $lt: range.to };
    const now = new Date();
    const [promos, activePromos, liveNow, byStatus, assisted, top] =
      await Promise.all([
        this.promoModel.countDocuments().exec(),
        this.promoModel.countDocuments({ status: PromoStatus.ACTIVE }).exec(),
        this.promoModel
          .countDocuments({
            status: PromoStatus.ACTIVE,
            startsAt: { $lte: now },
            endsAt: { $gt: now },
          })
          .exec(),
        this.redemptionModel
          .aggregate<{
            _id: PromoRedemptionStatus;
            count: number;
            discount: number;
          }>([
            { $match: { createdAt: window } },
            {
              $group: {
                _id: "$status",
                count: { $sum: 1 },
                discount: { $sum: "$discount" },
              },
            },
          ])
          .exec(),
        this.rideModel
          .aggregate<{ rides: number; value: number; discount: number }>([
            {
              $match: {
                status: RideStatus.COMPLETED,
                completedAt: window,
                "promo.code": { $exists: true },
              },
            },
            {
              $group: {
                _id: null,
                rides: { $sum: 1 },
                value: { $sum: { $ifNull: ["$fare.finalFare", 0] } },
                discount: { $sum: { $ifNull: ["$fare.discount", 0] } },
              },
            },
          ])
          .exec(),
        this.redemptionModel
          .aggregate<{
            _id: string;
            redeemed: number;
            discount: number;
            applied: number;
          }>([
            { $match: { createdAt: window } },
            {
              $group: {
                _id: "$code",
                applied: { $sum: 1 },
                redeemed: {
                  $sum: {
                    $cond: [
                      { $eq: ["$status", PromoRedemptionStatus.REDEEMED] },
                      1,
                      0,
                    ],
                  },
                },
                discount: {
                  $sum: {
                    $cond: [
                      { $eq: ["$status", PromoRedemptionStatus.REDEEMED] },
                      "$discount",
                      0,
                    ],
                  },
                },
              },
            },
            { $sort: { redeemed: -1, applied: -1 } },
            { $limit: 20 },
          ])
          .exec(),
      ]);
    const titles = await this.promoModel
      .find({ code: { $in: top.map((row) => row._id) } })
      .select("code title")
      .lean()
      .exec();
    const titleOf = new Map(titles.map((promo) => [promo.code, promo.title]));
    const count = (status: PromoRedemptionStatus) =>
      byStatus.find((row) => row._id === status)?.count ?? 0;
    return {
      range: this.rangeView(range),
      totals: {
        promos,
        activePromos,
        liveNow,
        applied: byStatus.reduce((sum, row) => sum + row.count, 0),
        redeemed: count(PromoRedemptionStatus.REDEEMED),
        released: count(PromoRedemptionStatus.RELEASED),
        // Ride-side figure (by completion date) so it reconciles with revenue.
        discountGiven: round2(assisted[0]?.discount ?? 0),
        promoAssistedRides: assisted[0]?.rides ?? 0,
        promoAssistedValue: round2(assisted[0]?.value ?? 0),
      },
      top: top.map((row) => ({
        code: row._id,
        title: titleOf.get(row._id) ?? row._id,
        redeemed: row.redeemed,
        discount: round2(row.discount),
        applied: row.applied,
      })),
    };
  }

  // ── Dashboard trends ──────────────────────────────────────────────────

  /** Last 7 local days: rides requested/completed/cancelled and completed value. */
  async trend(
    range: ReportRange = this.range({ preset: ReportPreset.LAST_7_DAYS }),
  ): Promise<
    Array<{
      date: string;
      requested: number;
      completed: number;
      cancelled: number;
      revenue: number;
    }>
  > {
    const [rides, revenue] = await Promise.all([
      this.rides(range),
      this.completedValueByDay(range),
    ]);
    return rides.byDay.map((day) => ({
      ...day,
      revenue: revenue.get(day.date) ?? 0,
    }));
  }

  // ── Shared building blocks ────────────────────────────────────────────

  private rangeView(range: ReportRange): RangeView {
    return {
      preset: range.preset,
      from: range.from,
      to: range.to,
      days: range.days.length,
      timeZone: range.timeZone,
    };
  }

  private settledPaymentStatuses(): PaymentStatus[] {
    return [
      PaymentStatus.CAPTURED,
      PaymentStatus.REFUNDED,
      PaymentStatus.PARTIALLY_REFUNDED,
    ];
  }

  /** Completed rides in range: Σ final fare and Σ promo discount (rupees). */
  private async completedValue(
    range: ReportRange,
  ): Promise<{ value: number; discounts: number; rides: number }> {
    const [row] = await this.rideModel
      .aggregate<{ value: number; discounts: number; rides: number }>([
        {
          $match: {
            status: RideStatus.COMPLETED,
            completedAt: { $gte: range.from, $lt: range.to },
          },
        },
        {
          $group: {
            _id: null,
            rides: { $sum: 1 },
            value: { $sum: { $ifNull: ["$fare.finalFare", 0] } },
            discounts: { $sum: { $ifNull: ["$fare.discount", 0] } },
          },
        },
      ])
      .exec();
    return {
      value: round2(row?.value ?? 0),
      discounts: round2(row?.discounts ?? 0),
      rides: row?.rides ?? 0,
    };
  }

  private async completedValueByDay(
    range: ReportRange,
  ): Promise<Map<string, number>> {
    const rows = await this.rideModel
      .aggregate<{ _id: string; value: number }>([
        {
          $match: {
            status: RideStatus.COMPLETED,
            completedAt: { $gte: range.from, $lt: range.to },
          },
        },
        {
          $group: {
            _id: {
              $dateToString: {
                format: "%Y-%m-%d",
                date: "$completedAt",
                timezone: range.timeZone,
              },
            },
            value: { $sum: { $ifNull: ["$fare.finalFare", 0] } },
          },
        },
      ])
      .exec();
    return new Map(rows.map((row) => [row._id, round2(row.value)]));
  }

  /** Money actually received in range (payments settled, by paidAt), online vs cash. */
  private async collected(
    range: ReportRange,
  ): Promise<{ online: number; cash: number }> {
    const rows = await this.paymentModel
      .aggregate<{ _id: string; total: number }>([
        {
          $match: {
            paidAt: { $gte: range.from, $lt: range.to },
            status: { $in: this.settledPaymentStatuses() },
          },
        },
        { $group: { _id: "$gateway", total: { $sum: "$amountPaise" } } },
      ])
      .exec();
    const cash =
      rows.find((row) => row._id === PaymentGateway.CASH)?.total ?? 0;
    const online = rows
      .filter((row) => row._id !== PaymentGateway.CASH)
      .reduce((sum, row) => sum + row.total, 0);
    return { online: toRupees(online), cash: toRupees(cash) };
  }

  /** Driver ledger lines for rides completed in range (rupees). */
  private async earningsTotals(
    range: ReportRange,
  ): Promise<{
    net: number;
    commission: number;
    gross: number;
    discounts: number;
    cashLines: number;
  }> {
    const [row] = await this.earningModel
      .aggregate<{
        net: number;
        commission: number;
        gross: number;
        discounts: number;
        cashLines: number;
      }>([
        { $match: { rideCompletedAt: { $gte: range.from, $lt: range.to } } },
        {
          $group: {
            _id: null,
            net: { $sum: "$netEarningPaise" },
            commission: { $sum: "$commissionPaise" },
            gross: { $sum: "$grossFarePaise" },
            discounts: { $sum: { $ifNull: ["$promoDiscountPaise", 0] } },
            cashLines: {
              $sum: {
                $cond: [{ $eq: ["$paymentMode", PaymentMode.CASH] }, 1, 0],
              },
            },
          },
        },
      ])
      .exec();
    return {
      net: toRupees(row?.net ?? 0),
      commission: toRupees(row?.commission ?? 0),
      gross: toRupees(row?.gross ?? 0),
      discounts: toRupees(row?.discounts ?? 0),
      cashLines: row?.cashLines ?? 0,
    };
  }

  /** Cancellation fees assessed in range, by resolution (rupees). */
  private async feeTotals(
    range: ReportRange,
  ): Promise<{ due: number; collected: number; waived: number }> {
    const rows = await this.cancellationModel
      .aggregate<{ _id: CancellationFeeStatus; total: number }>([
        {
          $match: {
            cancelledAt: { $gte: range.from, $lt: range.to },
            feeAmount: { $gt: 0 },
          },
        },
        { $group: { _id: "$feeStatus", total: { $sum: "$feeAmount" } } },
      ])
      .exec();
    const of = (status: CancellationFeeStatus) =>
      round2(rows.find((row) => row._id === status)?.total ?? 0);
    return {
      due: of(CancellationFeeStatus.DUE),
      collected: of(CancellationFeeStatus.COLLECTED),
      waived: of(CancellationFeeStatus.WAIVED),
    };
  }
}
