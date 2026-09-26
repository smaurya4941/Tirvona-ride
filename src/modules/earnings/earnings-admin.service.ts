import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import type { Model, QueryFilter } from "mongoose";
import { Types } from "mongoose";
import { ApiException, apiBadRequest, apiNotFound } from "../../common/exceptions/api.exception";
import { toRupees } from "../../common/utils/money";
import { DriverProfile } from "../drivers/schemas/driver-profile.schema";
import { User } from "../users/schemas/user.schema";
import type {
  AdminDriverLedgerQueryDto,
  AdminEarningsQueryDto,
  CreatePayoutDto,
  MarkEarningPaidDto,
} from "./dto/earnings-query.dto";
import { EarningsService, LEDGER_TOTALS, STATUS_TOTALS } from "./earnings.service";
import type { StatusTotalsRow } from "./earnings.service";
import { EarningStatus } from "./interfaces/earning-status";
import type {
  AdminDriverEarningsDetail,
  AdminDriverEarningsRow,
  AdminEarningsTotals,
  DriverRef,
  Paged,
  PayoutView,
} from "./interfaces/earning-views";
import { DriverEarning } from "./schemas/driver-earning.schema";
import { DriverPayout } from "./schemas/driver-payout.schema";
import type { DriverPayoutDocument } from "./schemas/driver-payout.schema";

interface DriverTotals {
  _id: Types.ObjectId;
  rides: number;
  gross: number;
  commission: number;
  net: number;
  pending: number;
  available: number;
  paid: number;
  collected: number;
  commissionDue: number;
  lastEarningAt?: Date;
}

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const nameOf = (user?: { firstName?: string; lastName?: string } | null): string =>
  [user?.firstName, user?.lastName].filter(Boolean).join(" ");
const netWhen = (status: EarningStatus) => ({
  $sum: { $cond: [{ $eq: ["$status", status] }, "$netEarningPaise", 0] },
});

// Per-driver totals from the ledger (paise).
const DRIVER_TOTALS = {
  _id: "$driverId",
  rides: { $sum: 1 },
  gross: { $sum: "$grossFarePaise" },
  commission: { $sum: "$commissionPaise" },
  net: { $sum: "$netEarningPaise" },
  pending: netWhen(EarningStatus.PENDING),
  available: netWhen(EarningStatus.AVAILABLE),
  paid: netWhen(EarningStatus.PAID),
  collected: netWhen(EarningStatus.COLLECTED),
  commissionDue: { $sum: { $cond: [{ $eq: ["$status", EarningStatus.COLLECTED] }, "$commissionPaise", 0] } },
  lastEarningAt: { $max: "$rideCompletedAt" },
} as const;

/** Admin reporting over the ledger, and manual payouts. */
@Injectable()
export class EarningsAdminService {
  private readonly logger = new Logger(EarningsAdminService.name);

  constructor(
    @InjectModel(DriverEarning.name) private readonly earningModel: Model<DriverEarning>,
    @InjectModel(DriverPayout.name) private readonly payoutModel: Model<DriverPayout>,
    @InjectModel(DriverProfile.name) private readonly driverModel: Model<DriverProfile>,
    @InjectModel(User.name) private readonly userModel: Model<User>,
    private readonly earnings: EarningsService,
  ) {}

  async totals(): Promise<AdminEarningsTotals> {
    await this.earnings.promoteMatured();
    const [[all], statuses, drivers] = await Promise.all([
      this.earningModel.aggregate<{ net: number; gross: number; commission: number; rides: number }>([
        { $group: LEDGER_TOTALS },
      ]),
      this.earningModel.aggregate<StatusTotalsRow>([{ $group: STATUS_TOTALS }]),
      this.earningModel.distinct("driverId"),
    ]);
    return {
      currency: "INR",
      rides: all?.rides ?? 0,
      gross: toRupees(all?.gross ?? 0),
      commission: toRupees(all?.commission ?? 0),
      net: toRupees(all?.net ?? 0),
      drivers: drivers.length,
      ...this.earnings.balancesFrom(statuses),
    };
  }

  /** One row per driver who has earned anything, most owed first. */
  async listDrivers(query: AdminEarningsQueryDto): Promise<Paged<AdminDriverEarningsRow>> {
    await this.earnings.promoteMatured();
    const match: QueryFilter<DriverEarning> = {};
    if (query.search) match.driverId = { $in: await this.searchDrivers(query.search) };

    const [result] = await this.earningModel
      .aggregate<{ items: DriverTotals[]; total: Array<{ count: number }> }>([
        { $match: match },
        { $group: DRIVER_TOTALS },
        { $sort: { available: -1, net: -1, _id: 1 } },
        {
          $facet: {
            items: [{ $skip: (query.page - 1) * query.limit }, { $limit: query.limit }],
            total: [{ $count: "count" }],
          },
        },
      ])
      .exec();
    const rows = result?.items ?? [];
    const total = result?.total[0]?.count ?? 0;
    const refs = await this.driverRefs(rows.map((row) => row._id));
    return {
      items: rows.map((row) => this.toRow(row, refs.get(row._id.toString()))),
      page: query.page,
      limit: query.limit,
      total,
      hasMore: query.page * query.limit < total,
    };
  }

  async driverDetail(driverId: string, query: AdminDriverLedgerQueryDto): Promise<AdminDriverEarningsDetail> {
    const id = new Types.ObjectId(driverId);
    const refs = await this.driverRefs([id]);
    const driver = refs.get(driverId);
    if (!driver) throw apiNotFound("Driver profile not found", "DRIVER_NOT_FOUND");
    await this.earnings.promoteMatured();

    const ledgerFilter: QueryFilter<DriverEarning> = { driverId: id };
    if (query.status) ledgerFilter.status = query.status;
    const [[totals], items, total, payouts] = await Promise.all([
      this.earningModel.aggregate<DriverTotals>([{ $match: { driverId: id } }, { $group: DRIVER_TOTALS }]),
      this.earningModel
        .find(ledgerFilter)
        .sort({ rideCompletedAt: -1, _id: -1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .exec(),
      this.earningModel.countDocuments(ledgerFilter).exec(),
      this.payoutModel.find({ driverId: id }).sort({ paidAt: -1 }).limit(50).exec(),
    ]);
    return {
      driver,
      summary: this.toRow(
        totals ?? {
          _id: id,
          rides: 0,
          gross: 0,
          commission: 0,
          net: 0,
          pending: 0,
          available: 0,
          paid: 0,
          collected: 0,
          commissionDue: 0,
        },
        driver,
      ),
      ledger: {
        items: items.map((earning) => this.earnings.toView(earning)),
        page: query.page,
        limit: query.limit,
        total,
        hasMore: query.page * query.limit < total,
      },
      payouts: await this.toPayoutViews(payouts),
    };
  }

  /** Mark a single AVAILABLE earning as paid (a one-line payout). */
  async markPaid(earningId: string, dto: MarkEarningPaidDto, adminUserId: string): Promise<PayoutView> {
    const earning = await this.earningModel.findById(earningId).select("driverId").lean().exec();
    if (!earning) throw apiNotFound("Earning not found", "EARNING_NOT_FOUND");
    return this.createPayout(
      { ...dto, driverId: earning.driverId.toString(), earningIds: [earningId] },
      adminUserId,
    );
  }

  /**
   * Records a manual settlement. Every listed earning must belong to the
   * driver and be AVAILABLE when the request arrives; the flip to PAID is a
   * conditional update, so two admins paying the same line concurrently
   * settle it exactly once, and the payout records only what it settled.
   */
  async createPayout(dto: CreatePayoutDto, adminUserId: string): Promise<PayoutView> {
    await this.earnings.promoteMatured();
    const driverId = new Types.ObjectId(dto.driverId);
    const ids = dto.earningIds.map((id) => new Types.ObjectId(id));

    const earnings = await this.earningModel
      .find({ _id: { $in: ids } })
      .select("driverId status netEarningPaise")
      .lean()
      .exec();
    if (earnings.length !== ids.length) throw apiNotFound("One or more earnings were not found", "EARNING_NOT_FOUND");
    if (earnings.some((earning) => !earning.driverId.equals(driverId)))
      throw apiBadRequest("Every earning in a payout must belong to the same driver", "VALIDATION_FAILED");
    const blocked = earnings.filter((earning) => earning.status !== EarningStatus.AVAILABLE);
    if (blocked.length)
      throw new ApiException(
        HttpStatus.CONFLICT,
        blocked.every((earning) => earning.status === EarningStatus.PAID)
          ? "These earnings have already been paid"
          : "Only AVAILABLE earnings can be paid out",
        "EARNING_NOT_AVAILABLE",
        { earnings: blocked.map((earning) => ({ id: earning._id.toString(), status: earning.status })) },
      );

    const paidAt = new Date();
    const paidBy = new Types.ObjectId(adminUserId);
    const payout = await this.payoutModel.create({
      driverId,
      earningIds: ids,
      earningCount: ids.length,
      amountPaise: earnings.reduce((sum, earning) => sum + earning.netEarningPaise, 0),
      currency: "INR",
      payoutReference: dto.payoutReference.trim(),
      note: dto.note?.trim(),
      paidBy,
      paidAt,
    });

    await this.earningModel
      .updateMany(
        { _id: { $in: ids }, driverId, status: EarningStatus.AVAILABLE },
        {
          $set: {
            status: EarningStatus.PAID,
            payoutId: payout._id,
            paidAt,
            paidBy,
            payoutReference: payout.payoutReference,
            payoutNote: payout.note,
          },
        },
      )
      .exec();

    // Reconcile with what this payout actually flipped (a concurrent payout
    // may have taken some lines between the check and the update).
    const settled = await this.earningModel
      .find({ payoutId: payout._id })
      .select("netEarningPaise")
      .lean()
      .exec();
    if (settled.length === 0) {
      await this.payoutModel.deleteOne({ _id: payout._id }).exec();
      throw new ApiException(
        HttpStatus.CONFLICT,
        "These earnings were paid by someone else just now",
        "EARNING_NOT_AVAILABLE",
      );
    }
    if (settled.length !== ids.length) {
      payout.earningIds = settled.map((earning) => earning._id);
      payout.earningCount = settled.length;
      payout.amountPaise = settled.reduce((sum, earning) => sum + earning.netEarningPaise, 0);
      await payout.save();
    }
    this.logger.log(
      `Payout ${payout._id.toString()} to driver ${dto.driverId}: ${payout.earningCount} earnings, ` +
        `${payout.amountPaise}p, ref ${payout.payoutReference} by ${adminUserId}`,
    );
    const [view] = await this.toPayoutViews([payout]);
    return view;
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  private async searchDrivers(search: string): Promise<Types.ObjectId[]> {
    const pattern = escapeRegex(search.trim());
    const users = await this.userModel
      .find({
        $or: [
          { phone: { $regex: pattern } },
          { firstName: { $regex: pattern, $options: "i" } },
          { lastName: { $regex: pattern, $options: "i" } },
        ],
      })
      .select("_id")
      .limit(200)
      .lean()
      .exec();
    const profiles = await this.driverModel
      .find({
        $or: [
          { driverCode: { $regex: `^${pattern}`, $options: "i" } },
          { userId: { $in: users.map((user) => user._id) } },
        ],
      })
      .select("_id")
      .limit(200)
      .lean()
      .exec();
    return profiles.map((profile) => profile._id);
  }

  private async driverRefs(driverIds: Types.ObjectId[]): Promise<Map<string, DriverRef>> {
    const profiles = await this.driverModel
      .find({ _id: { $in: driverIds } })
      .select("driverCode userId")
      .lean()
      .exec();
    const users = await this.userModel
      .find({ _id: { $in: profiles.map((profile) => profile.userId) } })
      .select("firstName lastName phone")
      .lean()
      .exec();
    const userById = new Map(users.map((user) => [user._id.toString(), user]));
    return new Map(
      profiles.map((profile) => {
        const user = userById.get(profile.userId.toString());
        return [
          profile._id.toString(),
          {
            driverId: profile._id.toString(),
            userId: profile.userId.toString(),
            driverCode: profile.driverCode,
            name: nameOf(user) || "Driver",
            phone: user?.phone ?? "",
          },
        ];
      }),
    );
  }

  private toRow(totals: DriverTotals, driver?: DriverRef): AdminDriverEarningsRow {
    return {
      driver: driver ?? {
        driverId: totals._id.toString(),
        userId: "",
        driverCode: "—",
        name: "Unknown driver",
        phone: "",
      },
      rides: totals.rides,
      gross: toRupees(totals.gross),
      commission: toRupees(totals.commission),
      net: toRupees(totals.net),
      pending: toRupees(totals.pending),
      available: toRupees(totals.available),
      paid: toRupees(totals.paid),
      collected: toRupees(totals.collected),
      commissionDue: toRupees(totals.commissionDue),
      lastEarningAt: totals.lastEarningAt,
    };
  }

  private async toPayoutViews(payouts: DriverPayoutDocument[]): Promise<PayoutView[]> {
    const admins = await this.userModel
      .find({ _id: { $in: payouts.map((payout) => payout.paidBy) } })
      .select("firstName lastName")
      .lean()
      .exec();
    const adminName = new Map(admins.map((admin) => [admin._id.toString(), nameOf(admin)]));
    return payouts.map((payout) => ({
      id: payout._id.toString(),
      driverId: payout.driverId.toString(),
      earningIds: payout.earningIds.map((id) => id.toString()),
      earningCount: payout.earningCount,
      amount: toRupees(payout.amountPaise),
      currency: payout.currency,
      payoutReference: payout.payoutReference,
      note: payout.note,
      paidBy: { id: payout.paidBy.toString(), name: adminName.get(payout.paidBy.toString()) || "Admin" },
      paidAt: payout.paidAt,
    }));
  }
}
