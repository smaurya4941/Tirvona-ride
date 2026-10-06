import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import type { Model, QueryFilter } from "mongoose";
import { Types } from "mongoose";
import {
  ApiException,
  apiBadRequest,
  apiConflict,
  apiNotFound,
} from "../../common/exceptions/api.exception";
import type { Page } from "../rides/rides.service";
import type { CreatePromoDto, UpdatePromoDto } from "./dto/promo.dto";
import {
  PromoDiscountType,
  PromoStatus,
  evaluatePromo,
  precheckPromo,
} from "./promo-rules";
import type { PromoDiscountRules, PromoEvaluation } from "./promo-rules";
import {
  PromoCode,
  PromoRedemption,
  PromoRedemptionStatus,
} from "./schemas/promo-code.schema";
import type { PromoCodeDocument } from "./schemas/promo-code.schema";

export interface PromoView {
  id: string;
  code: string;
  title: string;
  description?: string;
  discountType: PromoDiscountType;
  discountValue: number;
  maxDiscount?: number;
  minRideValue?: number;
  usageLimit?: number;
  perUserLimit: number;
  startsAt: Date;
  endsAt: Date;
  status: PromoStatus;
  /** ACTIVE + inside its window right now. */
  isLive: boolean;
  applicableRideTypes: string[];
  showInApp: boolean;
  usedCount: number;
  redeemedCount: number;
  discountGiven: number;
  createdAt: Date;
  updatedAt: Date;
}

/** What the customer app shows about a promo (no usage numbers). */
export interface CustomerPromoView {
  code: string;
  title: string;
  description?: string;
  discountType: PromoDiscountType;
  discountValue: number;
  maxDiscount?: number;
  minRideValue?: number;
  applicableRideTypes: string[];
  endsAt: Date;
}

export interface PromoRedemptionView {
  id: string;
  userId: string;
  rideId: string;
  rideType: string;
  discount: number;
  status: PromoRedemptionStatus;
  createdAt: Date;
  redeemedAt?: Date;
  releasedAt?: Date;
}

/** Snapshotted onto the ride when a promo is applied at booking. */
export interface AppliedPromo extends PromoDiscountRules {
  promoId: Types.ObjectId;
  code: string;
  title: string;
  estimatedDiscount: number;
}

const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isDuplicateKey = (error: unknown, index?: string): boolean => {
  const mongoError = error as { code?: number; message?: string } | undefined;
  return (
    mongoError?.code === 11000 &&
    (!index || (mongoError.message ?? "").includes(index))
  );
};
const ACTIVE_USE = [
  PromoRedemptionStatus.RESERVED,
  PromoRedemptionStatus.REDEEMED,
];

@Injectable()
export class PromotionsService {
  constructor(
    @InjectModel(PromoCode.name) private readonly promoModel: Model<PromoCode>,
    @InjectModel(PromoRedemption.name)
    private readonly redemptionModel: Model<PromoRedemption>,
  ) {}

  // ── Views ─────────────────────────────────────────────────────────────

  toView(promo: PromoCodeDocument, now = new Date()): PromoView {
    return {
      id: promo._id.toString(),
      code: promo.code,
      title: promo.title,
      description: promo.description,
      discountType: promo.discountType,
      discountValue: promo.discountValue,
      maxDiscount: promo.maxDiscount ?? undefined,
      minRideValue: promo.minRideValue ?? undefined,
      usageLimit: promo.usageLimit ?? undefined,
      perUserLimit: promo.perUserLimit,
      startsAt: promo.startsAt,
      endsAt: promo.endsAt,
      status: promo.status,
      isLive:
        promo.status === PromoStatus.ACTIVE &&
        promo.startsAt <= now &&
        promo.endsAt > now,
      applicableRideTypes: promo.applicableRideTypes,
      showInApp: promo.showInApp,
      usedCount: promo.usedCount,
      redeemedCount: promo.redeemedCount,
      discountGiven: promo.discountGiven,
      createdAt: promo.get("createdAt") as Date,
      updatedAt: promo.get("updatedAt") as Date,
    };
  }

  toCustomerView(promo: PromoCodeDocument): CustomerPromoView {
    return {
      code: promo.code,
      title: promo.title,
      description: promo.description,
      discountType: promo.discountType,
      discountValue: promo.discountValue,
      maxDiscount: promo.maxDiscount ?? undefined,
      minRideValue: promo.minRideValue ?? undefined,
      applicableRideTypes: promo.applicableRideTypes,
      endsAt: promo.endsAt,
    };
  }

  // ── Admin ─────────────────────────────────────────────────────────────

  async list(query: {
    page: number;
    limit: number;
    status?: PromoStatus;
    window?: "LIVE" | "SCHEDULED" | "EXPIRED";
    search?: string;
  }): Promise<Page<PromoView>> {
    const now = new Date();
    const filter: QueryFilter<PromoCode> = {};
    if (query.status) filter.status = query.status;
    if (query.window === "LIVE")
      Object.assign(filter, { startsAt: { $lte: now }, endsAt: { $gt: now } });
    if (query.window === "SCHEDULED") filter.startsAt = { $gt: now };
    if (query.window === "EXPIRED") filter.endsAt = { $lte: now };
    if (query.search) {
      const term = escapeRegex(query.search.trim());
      filter.$or = [
        { code: { $regex: term.toUpperCase() } },
        { title: { $regex: term, $options: "i" } },
      ];
    }
    const [promos, total] = await Promise.all([
      this.promoModel
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .exec(),
      this.promoModel.countDocuments(filter).exec(),
    ]);
    return {
      items: promos.map((promo) => this.toView(promo, now)),
      page: query.page,
      limit: query.limit,
      total,
      hasMore: query.page * query.limit < total,
    };
  }

  async get(id: string): Promise<PromoCodeDocument> {
    const promo = await this.promoModel.findById(id).exec();
    if (!promo) throw apiNotFound("Promo code not found", "PROMO_NOT_FOUND");
    return promo;
  }

  async recentRedemptions(
    promoId: Types.ObjectId,
    limit = 50,
  ): Promise<PromoRedemptionView[]> {
    const rows = await this.redemptionModel
      .find({ promoId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean()
      .exec();
    return rows.map((row) => ({
      id: row._id.toString(),
      userId: row.userId.toString(),
      rideId: row.rideId.toString(),
      rideType: row.rideType,
      discount: row.discount,
      status: row.status,
      createdAt: row.createdAt!,
      redeemedAt: row.redeemedAt,
      releasedAt: row.releasedAt,
    }));
  }

  async create(
    dto: CreatePromoDto,
    adminUserId: string,
  ): Promise<PromoCodeDocument> {
    this.assertRules(dto);
    try {
      return await this.promoModel.create({
        ...dto,
        applicableRideTypes: [...new Set(dto.applicableRideTypes ?? [])],
        perUserLimit: dto.perUserLimit ?? 1,
        status: dto.status ?? PromoStatus.ACTIVE,
        showInApp: dto.showInApp ?? false,
        createdBy: new Types.ObjectId(adminUserId),
        updatedBy: new Types.ObjectId(adminUserId),
      });
    } catch (error) {
      if (isDuplicateKey(error))
        throw apiConflict(
          `Promo code ${dto.code} already exists`,
          "PROMO_ALREADY_EXISTS",
        );
      throw error;
    }
  }

  async update(
    id: string,
    dto: UpdatePromoDto,
    adminUserId: string,
  ): Promise<PromoCodeDocument> {
    const promo = await this.get(id);
    const unset: Record<string, 1> = {};
    const set: Record<string, unknown> = {
      updatedBy: new Types.ObjectId(adminUserId),
    };
    for (const [key, value] of Object.entries(dto)) {
      if (value === undefined) continue;
      if (value === null) unset[key] = 1;
      else
        set[key] =
          key === "applicableRideTypes"
            ? [...new Set(value as string[])]
            : value;
    }
    const merged = {
      discountType:
        (set.discountType as PromoDiscountType | undefined) ??
        promo.discountType,
      discountValue:
        (set.discountValue as number | undefined) ?? promo.discountValue,
      startsAt: (set.startsAt as Date | undefined) ?? promo.startsAt,
      endsAt: (set.endsAt as Date | undefined) ?? promo.endsAt,
    };
    this.assertRules(merged);
    const usageLimit = set.usageLimit as number | undefined;
    if (usageLimit !== undefined && usageLimit < promo.usedCount)
      throw apiBadRequest(
        `This promo has already been used ${promo.usedCount} times; the limit cannot be lower`,
        "VALIDATION_FAILED",
      );

    const updated = await this.promoModel
      .findByIdAndUpdate(
        id,
        { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
        {
          returnDocument: "after",
          runValidators: true,
        },
      )
      .exec();
    if (!updated) throw apiNotFound("Promo code not found", "PROMO_NOT_FOUND");
    return updated;
  }

  async setStatus(
    id: string,
    status: PromoStatus,
    adminUserId: string,
  ): Promise<{ promo: PromoCodeDocument; changed: boolean }> {
    const promo = await this.get(id);
    if (promo.status === status) return { promo, changed: false };
    promo.status = status;
    promo.updatedBy = new Types.ObjectId(adminUserId);
    await promo.save();
    return { promo, changed: true };
  }

  // ── Customer ──────────────────────────────────────────────────────────

  /** Live promos flagged for the app's offers list. */
  async listForCustomers(): Promise<CustomerPromoView[]> {
    const now = new Date();
    const promos = await this.promoModel
      .find({
        showInApp: true,
        status: PromoStatus.ACTIVE,
        startsAt: { $lte: now },
        endsAt: { $gt: now },
      })
      .sort({ endsAt: 1 })
      .limit(20)
      .exec();
    return promos
      .filter(
        (promo) =>
          promo.usageLimit === undefined ||
          promo.usageLimit === null ||
          promo.usedCount < promo.usageLimit,
      )
      .map((promo) => this.toCustomerView(promo));
  }

  /**
   * Trip-free check for saving a code before a trip is chosen (Offers screen).
   * Works for codes not shown in the app too. Throws the specific PROMO_* error.
   */
  async check(userId: string, code: string): Promise<CustomerPromoView> {
    const promo = await this.promoModel
      .findOne({ code: code.trim().toUpperCase() })
      .exec();
    if (!promo)
      throw this.rejection({
        ok: false,
        code: "PROMO_INVALID",
        message: "This promo code is not valid",
      });
    const userUses = await this.redemptionModel
      .countDocuments({
        promoId: promo._id,
        userId: new Types.ObjectId(userId),
        status: { $in: ACTIVE_USE },
      })
      .exec();
    const result = precheckPromo(
      {
        status: promo.status,
        startsAt: promo.startsAt,
        endsAt: promo.endsAt,
        applicableRideTypes: promo.applicableRideTypes,
        usageLimit: promo.usageLimit ?? null,
        usedCount: promo.usedCount,
        perUserLimit: promo.perUserLimit,
        discountType: promo.discountType,
        discountValue: promo.discountValue,
      },
      { now: new Date(), userUses },
    );
    if (!result.ok) throw this.rejection(result);
    return this.toCustomerView(promo);
  }

  /** Full eligibility check against a server-priced fare. Never reserves. */
  async evaluate(
    userId: string,
    code: string,
    rideType: string,
    fare: number,
  ): Promise<{ promo: PromoCodeDocument | null; result: PromoEvaluation }> {
    const promo = await this.promoModel
      .findOne({ code: code.trim().toUpperCase() })
      .exec();
    if (!promo)
      return {
        promo: null,
        result: {
          ok: false,
          code: "PROMO_INVALID",
          message: "This promo code is not valid",
        },
      };
    const userUses = await this.redemptionModel
      .countDocuments({
        promoId: promo._id,
        userId: new Types.ObjectId(userId),
        status: { $in: ACTIVE_USE },
      })
      .exec();
    return {
      promo,
      result: evaluatePromo(
        {
          status: promo.status,
          startsAt: promo.startsAt,
          endsAt: promo.endsAt,
          minRideValue: promo.minRideValue ?? undefined,
          applicableRideTypes: promo.applicableRideTypes,
          usageLimit: promo.usageLimit ?? null,
          usedCount: promo.usedCount,
          perUserLimit: promo.perUserLimit,
          discountType: promo.discountType,
          discountValue: promo.discountValue,
          maxDiscount: promo.maxDiscount ?? undefined,
        },
        { now: new Date(), rideType, fare, userUses },
      ),
    };
  }

  /**
   * Validates and reserves one use for `rideId`, before the ride is written.
   * The global limit is enforced by a conditional increment (race-safe); the
   * per-user limit cannot race because a customer has at most one active
   * ride (a database-level unique index). Throws the specific PROMO_* error.
   */
  async reserve(input: {
    userId: string;
    code: string;
    rideId: Types.ObjectId;
    rideType: string;
    fare: number;
  }): Promise<AppliedPromo> {
    const { promo, result } = await this.evaluate(
      input.userId,
      input.code,
      input.rideType,
      input.fare,
    );
    if (!result.ok || !promo) throw this.rejection(result);

    const now = new Date();
    const claimed = await this.promoModel
      .findOneAndUpdate(
        {
          _id: promo._id,
          status: PromoStatus.ACTIVE,
          startsAt: { $lte: now },
          endsAt: { $gt: now },
          $or: [
            { usageLimit: { $exists: false } },
            { usageLimit: null },
            { $expr: { $lt: ["$usedCount", "$usageLimit"] } },
          ],
        },
        { $inc: { usedCount: 1 } },
        { returnDocument: "after" },
      )
      .exec();
    if (!claimed)
      throw this.rejection({
        ok: false,
        code: "PROMO_USAGE_LIMIT_REACHED",
        message: "This promo code has been fully used",
      });

    try {
      await this.redemptionModel.create({
        promoId: promo._id,
        code: promo.code,
        userId: new Types.ObjectId(input.userId),
        rideId: input.rideId,
        rideType: input.rideType,
        discount: result.discount,
        status: PromoRedemptionStatus.RESERVED,
      });
    } catch (error) {
      await this.promoModel
        .updateOne(
          { _id: promo._id, usedCount: { $gt: 0 } },
          { $inc: { usedCount: -1 } },
        )
        .exec();
      throw error;
    }

    return {
      promoId: promo._id,
      code: promo.code,
      title: promo.title,
      discountType: promo.discountType,
      discountValue: promo.discountValue,
      maxDiscount: promo.maxDiscount ?? undefined,
      estimatedDiscount: result.discount,
    };
  }

  /** The ride completed: the use becomes permanent with the final discount. Idempotent. */
  async redeem(
    rideId: Types.ObjectId | string,
    finalDiscount: number,
  ): Promise<boolean> {
    const redemption = await this.redemptionModel
      .findOneAndUpdate(
        {
          rideId: new Types.ObjectId(rideId),
          status: PromoRedemptionStatus.RESERVED,
        },
        {
          $set: {
            status: PromoRedemptionStatus.REDEEMED,
            discount: finalDiscount,
            redeemedAt: new Date(),
          },
        },
        { returnDocument: "after" },
      )
      .exec();
    if (!redemption) return false;
    await this.promoModel
      .updateOne(
        { _id: redemption.promoId },
        { $inc: { redeemedCount: 1, discountGiven: finalDiscount } },
      )
      .exec();
    return true;
  }

  /** The ride ended without a trip: give the use back. Idempotent. */
  async release(rideId: Types.ObjectId | string): Promise<boolean> {
    const redemption = await this.redemptionModel
      .findOneAndUpdate(
        {
          rideId: new Types.ObjectId(rideId),
          status: PromoRedemptionStatus.RESERVED,
        },
        {
          $set: {
            status: PromoRedemptionStatus.RELEASED,
            releasedAt: new Date(),
          },
        },
        { returnDocument: "after" },
      )
      .exec();
    if (!redemption) return false;
    await this.promoModel
      .updateOne(
        { _id: redemption.promoId, usedCount: { $gt: 0 } },
        { $inc: { usedCount: -1 } },
      )
      .exec();
    return true;
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  rejection(result: PromoEvaluation): ApiException {
    if (result.ok) throw new Error("rejection() called for a valid promo");
    return new ApiException(
      result.code === "PROMO_INVALID" ? 404 : 400,
      result.message,
      result.code,
    );
  }

  private assertRules(rules: {
    discountType: PromoDiscountType;
    discountValue: number;
    startsAt: Date;
    endsAt: Date;
  }): void {
    if (
      rules.discountType === PromoDiscountType.PERCENTAGE &&
      rules.discountValue > 100
    )
      throw apiBadRequest(
        "A percentage discount cannot exceed 100",
        "VALIDATION_FAILED",
      );
    if (rules.endsAt <= rules.startsAt)
      throw apiBadRequest(
        "The end date must be after the start date",
        "VALIDATION_FAILED",
      );
  }
}
