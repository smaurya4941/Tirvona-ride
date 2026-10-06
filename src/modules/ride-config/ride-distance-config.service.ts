import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import type { Model } from "mongoose";
import { Types } from "mongoose";
import {
  ApiException,
  apiBadRequest,
} from "../../common/exceptions/api.exception";
import { RideType } from "../ride-types/schemas/ride-type.schema";
import { distanceLimitsProblem } from "./distance-policy";
import type { DistanceLimits } from "./distance-policy";
import { MIGRATION_DEFAULTS } from "./ride-config.limits";
import { RideDistanceConfig } from "./schemas/ride-distance-config.schema";
import type { RideDistanceConfigDocument } from "./schemas/ride-distance-config.schema";

const isDuplicateKey = (error: unknown): boolean =>
  (error as { code?: number } | undefined)?.code === 11000;

export interface RideDistanceConfigView extends DistanceLimits {
  id: string;
  rideType: string;
  version: number;
  updatedBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Per-ride-type trip distance limits, straight from MongoDB on every call —
 * no cache, so an admin edit applies to the very next request on every
 * instance. A missing or unusable row is a 503, never a made-up default.
 */
@Injectable()
export class RideDistanceConfigService {
  private readonly logger = new Logger(RideDistanceConfigService.name);

  constructor(
    @InjectModel(RideDistanceConfig.name)
    private readonly configModel: Model<RideDistanceConfig>,
    @InjectModel(RideType.name) private readonly rideTypeModel: Model<RideType>,
  ) {}

  toView(config: RideDistanceConfigDocument): RideDistanceConfigView {
    return {
      id: config._id.toString(),
      rideType: config.rideType,
      minDistanceMeters: config.minDistanceMeters,
      maxDistanceKm: config.maxDistanceKm,
      version: config.version,
      updatedBy: config.updatedBy?.toString(),
      createdAt: config.get("createdAt") as Date,
      updatedAt: config.get("updatedAt") as Date,
    };
  }

  /** A stored row an admin (or a bad manual edit) left unusable counts as no configuration. */
  assertUsable(
    rideType: string,
    config: RideDistanceConfigDocument | null,
  ): RideDistanceConfigDocument {
    if (!config)
      throw new ApiException(
        HttpStatus.SERVICE_UNAVAILABLE,
        "Trip distance limits are not configured for this ride type",
        "RIDE_DISTANCE_CONFIG_MISSING",
        { rideType },
      );
    if (distanceLimitsProblem(config) !== null) {
      this.logger.error(
        `Ride distance configuration for ${rideType} is invalid: ${distanceLimitsProblem(config)}`,
      );
      throw new ApiException(
        HttpStatus.SERVICE_UNAVAILABLE,
        "Trip distance limits for this ride type are misconfigured",
        "RIDE_DISTANCE_CONFIG_INVALID",
        { rideType },
      );
    }
    return config;
  }

  /** The limits for one ride type, or a 503 when there are none. */
  async getRequired(rideType: string): Promise<RideDistanceConfigDocument> {
    return this.assertUsable(
      rideType,
      await this.configModel.findOne({ rideType }).exec(),
    );
  }

  async find(rideType: string): Promise<RideDistanceConfigDocument | null> {
    return this.configModel.findOne({ rideType }).exec();
  }

  /** One query for several ride types (the "estimate every ride type" quote). */
  async findMany(
    rideTypes: string[],
  ): Promise<Map<string, RideDistanceConfigDocument>> {
    const rows = await this.configModel
      .find({ rideType: { $in: rideTypes } })
      .exec();
    return new Map(rows.map((row) => [row.rideType, row]));
  }

  async listAll(): Promise<RideDistanceConfigDocument[]> {
    return this.configModel.find().exec();
  }

  /** Activation guard: a ride type may only be bookable with sound limits on file. */
  async hasUsable(rideType: string): Promise<boolean> {
    const config = await this.find(rideType);
    return config !== null && distanceLimitsProblem(config) === null;
  }

  /**
   * Admin edit. Missing fields keep their stored value; a ride type without a
   * row needs both. The merged pair is validated as a whole (min < max) and the
   * write is one atomic upsert that bumps `version`.
   */
  async save(
    rideType: string,
    changes: Partial<DistanceLimits>,
    adminId: string,
  ): Promise<{
    before: RideDistanceConfigDocument | null;
    after: RideDistanceConfigDocument;
  }> {
    const before = await this.find(rideType);
    const merged = {
      minDistanceMeters: changes.minDistanceMeters ?? before?.minDistanceMeters,
      maxDistanceKm: changes.maxDistanceKm ?? before?.maxDistanceKm,
    };
    if (
      merged.minDistanceMeters === undefined ||
      merged.maxDistanceKm === undefined
    )
      throw apiBadRequest(
        "This ride type has no distance limits yet: provide both the minimum and the maximum",
        "RIDE_DISTANCE_CONFIG_INCOMPLETE",
      );
    const problem = distanceLimitsProblem(merged);
    if (problem) throw apiBadRequest(problem, "VALIDATION_FAILED");

    const rideTypeRow = await this.rideTypeModel
      .findOne({ code: rideType })
      .select("_id")
      .lean()
      .exec();
    const after = await this.configModel
      .findOneAndUpdate(
        { rideType },
        {
          $set: {
            ...merged,
            updatedBy: new Types.ObjectId(adminId),
            ...(rideTypeRow ? { rideTypeId: rideTypeRow._id } : {}),
          },
          $inc: { version: 1 },
          $setOnInsert: { rideType },
        },
        { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
      )
      .exec();
    return { before, after };
  }

  /**
   * First-boot migration, idempotent and safe across instances: every ride
   * type that has no row yet gets the limits that were in force before they
   * became admin-controlled. Existing rows are never touched.
   */
  async migrateMissing(): Promise<void> {
    const rideTypes = await this.rideTypeModel
      .find()
      .select("code")
      .lean()
      .exec();
    for (const rideType of rideTypes) {
      try {
        const result = await this.configModel
          .updateOne(
            { rideType: rideType.code },
            {
              $setOnInsert: {
                rideType: rideType.code,
                rideTypeId: rideType._id,
                minDistanceMeters: MIGRATION_DEFAULTS.minDistanceMeters,
                maxDistanceKm: MIGRATION_DEFAULTS.maxDistanceKm,
                version: 1,
              },
            },
            { upsert: true },
          )
          .exec();
        if (result.upsertedCount > 0)
          this.logger.log(
            `Migrated ${rideType.code} distance limits: ${MIGRATION_DEFAULTS.minDistanceMeters} m – ${MIGRATION_DEFAULTS.maxDistanceKm} km`,
          );
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
      }
    }
  }
}
