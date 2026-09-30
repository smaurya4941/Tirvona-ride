import { createHash } from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectModel } from "@nestjs/mongoose";
import type { Model } from "mongoose";
import { Types } from "mongoose";
import { apiBadRequest, apiConflict, apiNotFound } from "../../common/exceptions/api.exception";
import { DriverProfile } from "../drivers/schemas/driver-profile.schema";
import { rideNotFound } from "../rides/ride-errors";
import { Ride } from "../rides/schemas/ride.schema";
import type { RideDocument } from "../rides/schemas/ride.schema";
import { User } from "../users/schemas/user.schema";
import type { CreateRatingDto } from "./dto/rating.dto";
import { RatingBlocker, ratingEligibility } from "./rating-eligibility";
import { Rating } from "./schemas/rating.schema";
import type { RatingDocument } from "./schemas/rating.schema";

export interface RatingView {
  id: string;
  rideId: string;
  rating: number;
  comment?: string;
  createdAt: Date;
}

export interface RideRatingStatus {
  rideId: string;
  canRate: boolean;
  /** Why not, when `canRate` is false and no rating exists. */
  reason?: RatingBlocker;
  windowEndsAt?: Date;
  rating: RatingView | null;
  /** Who is being rated — for the rating screen header. */
  driver: {
    name: string;
    ratingAverage: number;
    ratingCount: number;
    vehicle?: { vehicleType: string; registrationNumber: string; make?: string; model?: string; color?: string };
  } | null;
}

/**
 * One rating as the rated driver sees it: stars, the comment and the day.
 * No ride, rider, time of day or id that leads back to either — riders rate
 * honestly only if the driver cannot tell who wrote what.
 */
export interface DriverReviewView {
  /** Opaque key for list rendering; not the rating's database id. */
  key: string;
  rating: number;
  comment?: string;
  /** Calendar day in the app time zone, "YYYY-MM-DD". */
  ratedOn: string;
}

export interface DriverReviewsPage {
  items: DriverReviewView[];
  /** Pass as `cursor` for the next page; null when there are no more. */
  nextCursor: string | null;
}

export interface DriverRatingSummary {
  ratingAverage: number;
  ratingCount: number;
  totalRides: number;
  /** Stars → count, "1" … "5". */
  distribution: Record<"1" | "2" | "3" | "4" | "5", number>;
}

const isDuplicateKey = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: number }).code === 11000;

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** Position after a row, as an opaque string. */
const encodeCursor = (createdAt: Date, id: Types.ObjectId): string =>
  Buffer.from(`${createdAt.getTime()}:${id.toHexString()}`).toString("base64url");

const decodeCursor = (cursor: string): { createdAt: Date; id: Types.ObjectId } | null => {
  const [millis, id] = Buffer.from(cursor, "base64url").toString("utf8").split(":");
  const time = Number(millis);
  if (!Number.isSafeInteger(time) || !id || !Types.ObjectId.isValid(id)) return null;
  return { createdAt: new Date(time), id: new Types.ObjectId(id) };
};

/** Stable per rating, but not the id (which would reveal the exact time). */
const reviewKey = (id: Types.ObjectId): string => createHash("sha256").update(id.toHexString()).digest("hex").slice(0, 16);

/**
 * Customer → driver ratings. NestJS decides everything: whether the ride is
 * rateable (owned, completed, paid, in window, not yet rated) and which
 * driver the stars belong to (`ride.driverId`, never the request body).
 */
@Injectable()
export class RatingsService {
  private readonly logger = new Logger(RatingsService.name);
  private readonly windowDays: number;
  private readonly dayFormat: Intl.DateTimeFormat;

  constructor(
    @InjectModel(Rating.name) private readonly ratingModel: Model<Rating>,
    @InjectModel(Ride.name) private readonly rideModel: Model<Ride>,
    @InjectModel(DriverProfile.name) private readonly driverModel: Model<DriverProfile>,
    @InjectModel(User.name) private readonly userModel: Model<User>,
    config: ConfigService,
  ) {
    this.windowDays = config.getOrThrow<number>("ratingWindowDays");
    // en-CA formats as YYYY-MM-DD.
    this.dayFormat = new Intl.DateTimeFormat("en-CA", {
      timeZone: config.getOrThrow<string>("appTimeZone"),
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  }

  async statusForRide(customerUserId: string, rideId: string): Promise<RideRatingStatus> {
    const ride = await this.customerRide(customerUserId, rideId);
    const existing = await this.ratingModel.findOne({ rideId: ride._id }).exec();
    const eligibility = ratingEligibility(ride, Boolean(existing), this.windowDays);
    return {
      rideId: ride._id.toString(),
      canRate: eligibility.canRate,
      reason: existing ? undefined : eligibility.reason,
      windowEndsAt: eligibility.windowEndsAt,
      rating: existing ? this.toView(existing) : null,
      driver: await this.driverSummary(ride),
    };
  }

  async rate(customerUserId: string, rideId: string, dto: CreateRatingDto): Promise<RatingView> {
    const ride = await this.customerRide(customerUserId, rideId);
    const already = await this.ratingModel.exists({ rideId: ride._id }).exec();
    const eligibility = ratingEligibility(ride, Boolean(already), this.windowDays);
    if (!eligibility.canRate) {
      if (eligibility.reason === RatingBlocker.ALREADY_RATED)
        throw apiConflict("You have already rated this ride", "RATING_ALREADY_EXISTS");
      if (eligibility.reason === RatingBlocker.WINDOW_CLOSED)
        throw apiConflict("This ride can no longer be rated", "RATING_WINDOW_CLOSED");
      throw apiConflict(
        eligibility.reason === RatingBlocker.PAYMENT_NOT_VERIFIED
          ? "You can rate this ride once the payment is complete"
          : "Only completed rides can be rated",
        "RATING_NOT_ALLOWED",
      );
    }

    let rating: RatingDocument;
    try {
      rating = await this.ratingModel.create({
        rideId: ride._id,
        customerId: ride.customerId,
        driverId: ride.driverId,
        driverUserId: ride.driverUserId,
        rating: dto.rating,
        comment: dto.comment,
      });
    } catch (error) {
      // A double tap racing itself: the unique index lets exactly one in.
      if (isDuplicateKey(error)) throw apiConflict("You have already rated this ride", "RATING_ALREADY_EXISTS");
      throw error;
    }
    await this.applyToDriver(rating);
    return this.toView(rating);
  }

  /** Aggregate for the driver app (`GET /drivers/me/ratings`). */
  async summaryForDriverUser(driverUserId: string): Promise<DriverRatingSummary> {
    const driver = await this.driverModel.findOne({ userId: new Types.ObjectId(driverUserId) }).exec();
    if (!driver) throw apiNotFound("Driver profile not found", "DRIVER_NOT_FOUND");
    const rows = await this.ratingModel
      .aggregate<{ _id: number; count: number }>([
        { $match: { driverId: driver._id } },
        { $group: { _id: "$rating", count: { $sum: 1 } } },
      ])
      .exec();
    const distribution = { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 };
    for (const row of rows) distribution[String(row._id) as keyof typeof distribution] = row.count;
    return {
      ratingAverage: driver.ratingAverage,
      ratingCount: driver.ratingCount ?? 0,
      totalRides: driver.totalRides,
      distribution,
    };
  }

  /** The driver's individual ratings, newest first (`GET /drivers/me/ratings/reviews`). */
  async reviewsForDriverUser(
    driverUserId: string,
    query: { cursor?: string; limit: number; stars?: number; withComment?: boolean },
  ): Promise<DriverReviewsPage> {
    const driver = await this.driverModel.findOne({ userId: new Types.ObjectId(driverUserId) }).select("_id").lean().exec();
    if (!driver) throw apiNotFound("Driver profile not found", "DRIVER_NOT_FOUND");

    const filter: Record<string, unknown> = { driverId: driver._id };
    if (query.stars !== undefined) filter.rating = query.stars;
    if (query.withComment) filter.comment = { $exists: true, $nin: [null, ""] };
    const after = query.cursor ? decodeCursor(query.cursor) : null;
    if (query.cursor && !after) throw apiBadRequest("Invalid cursor", "VALIDATION_FAILED");
    if (after)
      filter.$or = [
        { createdAt: { $lt: after.createdAt } },
        { createdAt: after.createdAt, _id: { $lt: after.id } },
      ];

    const rows = await this.ratingModel
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(query.limit + 1)
      .select("rating comment createdAt")
      .lean()
      .exec();
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => ({
        key: reviewKey(row._id),
        rating: row.rating,
        comment: row.comment || undefined,
        ratedOn: this.dayFormat.format(row.createdAt),
      })),
      nextCursor: rows.length > query.limit && last ? encodeCursor(last.createdAt, last._id) : null,
    };
  }

  /**
   * Recomputes a driver's aggregate from the ratings collection — the source
   * of truth. Used when the incremental update below could not be applied.
   */
  async rebuildDriverAggregate(driverId: Types.ObjectId): Promise<void> {
    const [row] = await this.ratingModel
      .aggregate<{ sum: number; count: number }>([
        { $match: { driverId } },
        { $group: { _id: null, sum: { $sum: "$rating" }, count: { $sum: 1 } } },
      ])
      .exec();
    const sum = row?.sum ?? 0;
    const count = row?.count ?? 0;
    await this.driverModel
      .updateOne(
        { _id: driverId },
        { $set: { ratingSum: sum, ratingCount: count, ratingAverage: count ? round2(sum / count) : 0 } },
      )
      .exec();
  }

  /**
   * Atomic per-driver update (one pipeline write): concurrent ratings for the
   * same driver can never lose each other's stars.
   */
  private async applyToDriver(rating: RatingDocument): Promise<void> {
    try {
      await this.driverModel
        .updateOne({ _id: rating.driverId }, [
          {
            $set: {
              ratingSum: { $add: [{ $ifNull: ["$ratingSum", 0] }, rating.rating] },
              ratingCount: { $add: [{ $ifNull: ["$ratingCount", 0] }, 1] },
            },
          },
          { $set: { ratingAverage: { $round: [{ $divide: ["$ratingSum", "$ratingCount"] }, 2] } } },
        ])
        .exec();
    } catch (error) {
      this.logger.error(
        `Incremental rating update failed for driver ${rating.driverId.toString()}; rebuilding`,
        error instanceof Error ? error.stack : String(error),
      );
      await this.rebuildDriverAggregate(rating.driverId);
    }
  }

  private async customerRide(customerUserId: string, rideId: string): Promise<RideDocument> {
    const ride = await this.rideModel
      .findOne({ _id: new Types.ObjectId(rideId), customerId: new Types.ObjectId(customerUserId) })
      .exec();
    // Someone else's ride is indistinguishable from a missing one.
    if (!ride) throw rideNotFound();
    return ride;
  }

  private async driverSummary(ride: RideDocument): Promise<RideRatingStatus["driver"]> {
    if (!ride.driverId) return null;
    const profile = await this.driverModel.findById(ride.driverId).lean().exec();
    if (!profile) return null;
    const user = await this.userModel.findById(profile.userId).select("firstName lastName").lean().exec();
    return {
      name: user ? [user.firstName, user.lastName].filter(Boolean).join(" ") : "Your driver",
      ratingAverage: profile.ratingAverage,
      ratingCount: profile.ratingCount ?? 0,
      vehicle: ride.vehicle
        ? {
            vehicleType: ride.vehicle.vehicleType,
            registrationNumber: ride.vehicle.registrationNumber,
            make: ride.vehicle.make,
            model: ride.vehicle.model,
            color: ride.vehicle.color,
          }
        : undefined,
    };
  }

  private toView(rating: RatingDocument): RatingView {
    return {
      id: rating._id.toString(),
      rideId: rating.rideId.toString(),
      rating: rating.rating,
      comment: rating.comment,
      createdAt: rating.createdAt,
    };
  }
}
