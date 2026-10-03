import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import type { OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectModel } from "@nestjs/mongoose";
import type { Model } from "mongoose";
import { Types } from "mongoose";
import { ApiException, apiBadRequest, apiConflict, apiNotFound } from "../../common/exceptions/api.exception";
import { RideType } from "../ride-types/schemas/ride-type.schema";
import type { UpdateCommissionDto } from "./dto/commission.dto";
import { CommissionConfigStatus, CommissionPhase, CommissionType } from "./interfaces/earning-status";
import type { CommissionChangeResult, CommissionView, RideTypeCommissionView } from "./interfaces/earning-views";
import { CommissionConfig } from "./schemas/commission-config.schema";
import type { CommissionConfigDocument } from "./schemas/commission-config.schema";

const isDuplicateKey = (error: unknown): boolean => (error as { code?: number } | undefined)?.code === 11000;

// A change may be back-dated by at most this much (clock skew between the
// admin's browser and the server), never further: history is not rewritable.
const BACKDATE_TOLERANCE_MS = 5 * 60_000;

/**
 * Per-ride-type commission: each ride type has its own versioned rate
 * history. Admin edits append a version to that ride type's history; the
 * earnings ledger captures the version in force when each ride was finalised,
 * so historical earnings never change when a rate does.
 *
 * `resolve()` is the one place that answers "what commission applies to this
 * ride type at this time?".
 */
@Injectable()
export class CommissionService implements OnModuleInit {
  private readonly logger = new Logger(CommissionService.name);
  private readonly defaultPercent: number;

  constructor(
    @InjectModel(CommissionConfig.name) private readonly configModel: Model<CommissionConfig>,
    @InjectModel(RideType.name) private readonly rideTypeModel: Model<RideType>,
    config: ConfigService,
  ) {
    this.defaultPercent = config.getOrThrow<number>("defaultCommissionPercent");
  }

  async onModuleInit(): Promise<void> {
    await this.dropLegacyIndexes();
    await this.seedAll();
  }

  // ── Migration / seeding ───────────────────────────────────────────────

  /** The pre-per-ride-type unique index on `version` alone would reject Bike v1 next to Cab v1. */
  private async dropLegacyIndexes(): Promise<void> {
    try {
      await this.configModel.collection.dropIndex("version_1");
      this.logger.log("Dropped the legacy global commission index version_1");
    } catch {
      // Not there (new database or already dropped).
    }
  }

  /** Gives every existing ride type a commission history (migration on first boot, idempotent). */
  async seedAll(): Promise<void> {
    const codes = (await this.rideTypeModel.find().select("code").lean().exec()).map((rideType) => rideType.code);
    for (const code of codes) await this.ensureForRideType(code);
  }

  /**
   * Makes sure a ride type has a commission history.
   *
   * - Upgrading from the global commission: the old history is copied onto
   *   the ride type, version for version, so every rate keeps its date and
   *   number and a ride type starts at exactly what it paid before. The
   *   global rows themselves stay (old earnings point at them).
   * - Otherwise v1 starts at DEFAULT_COMMISSION_PERCENT.
   *
   * Safe to call concurrently and repeatedly.
   */
  async ensureForRideType(rideType: string): Promise<void> {
    if (await this.configModel.exists({ rideType })) return;
    const legacy = await this.configModel
      .find({ rideType: { $exists: false } })
      .sort({ version: 1 })
      .lean()
      .exec();
    const rows = legacy.length
      ? legacy.map((row) => ({
          rideType,
          version: row.version,
          type: row.type,
          value: row.value,
          effectiveFrom: row.effectiveFrom,
          status: row.status,
          note: row.note,
          createdBy: row.createdBy,
          cancelledBy: row.cancelledBy,
          cancelledAt: row.cancelledAt,
        }))
      : [
          {
            rideType,
            version: 1,
            type: CommissionType.PERCENTAGE,
            value: this.defaultPercent,
            effectiveFrom: new Date(),
            status: CommissionConfigStatus.ACTIVE,
            note: "Initial commission",
          },
        ];
    try {
      await this.configModel.insertMany(rows, { ordered: true });
      this.logger.log(
        legacy.length
          ? `Copied ${rows.length} global commission version(s) to ${rideType}`
          : `Seeded ${rideType} commission v1 at ${this.defaultPercent}%`,
      );
    } catch (error) {
      // A concurrent boot or request created it first.
      if (!isDuplicateKey(error) && !(error as { writeErrors?: unknown[] }).writeErrors) throw error;
    }
  }

  // ── Resolver ──────────────────────────────────────────────────────────

  /**
   * The commission version for `rideType` in force at `at` (default now):
   * the ACTIVE version with the latest `effectiveFrom ≤ at`. For a moment
   * before the ride type's first version (history that predates the
   * migration), the earliest version applies.
   */
  async resolve(rideType: string, at: Date = new Date()): Promise<CommissionConfigDocument> {
    const found = await this.findInForce(rideType, at);
    if (found) return found;
    await this.ensureForRideType(rideType);
    const retried =
      (await this.findInForce(rideType, at)) ??
      (await this.configModel
        .findOne({ rideType, status: CommissionConfigStatus.ACTIVE })
        .sort({ effectiveFrom: 1, version: 1 })
        .exec());
    if (!retried)
      throw new ApiException(
        HttpStatus.SERVICE_UNAVAILABLE,
        `No commission rate is configured for ${rideType}`,
        "COMMISSION_NOT_CONFIGURED",
      );
    return retried;
  }

  private findInForce(rideType: string, at: Date): Promise<CommissionConfigDocument | null> {
    return this.configModel
      .findOne({ rideType, status: CommissionConfigStatus.ACTIVE, effectiveFrom: { $lte: at } })
      .sort({ effectiveFrom: -1, version: -1 })
      .exec();
  }

  // ── Reading (admin) ───────────────────────────────────────────────────

  /** Every ride type with its current and scheduled commission. */
  async overview(): Promise<RideTypeCommissionView[]> {
    const rideTypes = await this.rideTypeModel.find().sort({ sortOrder: 1, code: 1 }).lean().exec();
    return Promise.all(rideTypes.map((rideType) => this.currentFor(rideType)));
  }

  async forRideType(code: string): Promise<RideTypeCommissionView & { history: CommissionView[] }> {
    const rideType = await this.requireRideType(code);
    const [summary, history] = await Promise.all([this.currentFor(rideType), this.history(code)]);
    return { ...summary, history };
  }

  private async currentFor(rideType: Pick<RideType, "code" | "displayName" | "isActive">): Promise<RideTypeCommissionView> {
    const now = new Date();
    const [current, scheduled] = await Promise.all([
      this.resolve(rideType.code, now).catch(() => null),
      this.configModel
        .find({ rideType: rideType.code, status: CommissionConfigStatus.ACTIVE, effectiveFrom: { $gt: now } })
        .sort({ effectiveFrom: 1, version: 1 })
        .exec(),
    ]);
    return {
      rideType: { code: rideType.code, displayName: rideType.displayName, isActive: rideType.isActive },
      current: current ? this.toView(current, CommissionPhase.CURRENT) : null,
      scheduled: scheduled.map((entry) => this.toView(entry, CommissionPhase.SCHEDULED)),
    };
  }

  /** One ride type's versions, newest first, each labelled SCHEDULED / CURRENT / SUPERSEDED / CANCELLED. */
  async history(code: string): Promise<CommissionView[]> {
    await this.requireRideType(code);
    const now = new Date();
    const [all, current] = await Promise.all([
      this.configModel.find({ rideType: code }).sort({ effectiveFrom: -1, version: -1 }).limit(200).exec(),
      this.resolve(code, now).catch(() => null),
    ]);
    return all.map((entry) => {
      let phase: CommissionPhase;
      if (entry.status === CommissionConfigStatus.CANCELLED) phase = CommissionPhase.CANCELLED;
      else if (current?._id.equals(entry._id)) phase = CommissionPhase.CURRENT;
      else if (entry.effectiveFrom > now) phase = CommissionPhase.SCHEDULED;
      else phase = CommissionPhase.SUPERSEDED;
      return this.toView(entry, phase);
    });
  }

  // ── Writing (admin) ───────────────────────────────────────────────────

  /** Appends a version to the ride type's history; earlier versions stay untouched. */
  async update(rideType: string, dto: UpdateCommissionDto, adminUserId: string): Promise<CommissionChangeResult> {
    await this.requireRideType(rideType);
    await this.ensureForRideType(rideType);

    const now = Date.now();
    const effectiveFrom = dto.effectiveFrom ? new Date(dto.effectiveFrom) : new Date(now);
    if (Number.isNaN(effectiveFrom.getTime()))
      throw apiBadRequest("effectiveFrom must be a valid date", "VALIDATION_FAILED");
    if (effectiveFrom.getTime() < now - BACKDATE_TOLERANCE_MS)
      throw apiBadRequest(
        "A commission change cannot take effect in the past — earnings already recorded keep their rate",
        "VALIDATION_FAILED",
      );

    if (await this.configModel.exists({ rideType, status: CommissionConfigStatus.ACTIVE, effectiveFrom }))
      throw apiConflict(
        `${rideType} already has a commission taking effect at exactly that time. Pick another time, or cancel the scheduled change first.`,
        "COMMISSION_VERSION_CONFLICT",
      );

    // What would be in force at that moment without this change.
    const before = await this.resolve(rideType, effectiveFrom);
    if (before.value === dto.value && before.effectiveFrom <= effectiveFrom)
      throw apiBadRequest(
        `${rideType} commission is already ${dto.value}% at that time (v${before.version})`,
        "COMMISSION_UNCHANGED",
      );

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const latest = await this.configModel.findOne({ rideType }).sort({ version: -1 }).select("version").lean().exec();
      try {
        const created = await this.configModel.create({
          rideType,
          version: (latest?.version ?? 0) + 1,
          type: dto.type ?? CommissionType.PERCENTAGE,
          value: dto.value,
          effectiveFrom,
          status: CommissionConfigStatus.ACTIVE,
          note: dto.note,
          createdBy: new Types.ObjectId(adminUserId),
        });
        this.logger.log(
          `${rideType} commission v${created.version} = ${created.value}% from ${effectiveFrom.toISOString()} by ${adminUserId}`,
        );
        return {
          commission: this.toView(
            created,
            effectiveFrom.getTime() > Date.now() ? CommissionPhase.SCHEDULED : CommissionPhase.CURRENT,
          ),
          previousValue: before.value,
        };
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
        // Same start instant taken meanwhile → conflict; otherwise another admin took the version number: retry.
        if (await this.configModel.exists({ rideType, status: CommissionConfigStatus.ACTIVE, effectiveFrom }))
          throw apiConflict(
            `${rideType} already has a commission taking effect at exactly that time.`,
            "COMMISSION_VERSION_CONFLICT",
          );
      }
    }
    throw new ApiException(HttpStatus.CONFLICT, "Commission changed concurrently. Retry.", "VALIDATION_FAILED");
  }

  /** Withdraws a scheduled change. Versions already in force cannot be cancelled. */
  async cancelScheduled(id: string, adminUserId: string): Promise<CommissionView> {
    const cancelled = await this.configModel
      .findOneAndUpdate(
        {
          _id: id,
          rideType: { $exists: true },
          status: CommissionConfigStatus.ACTIVE,
          effectiveFrom: { $gt: new Date() },
        },
        {
          $set: {
            status: CommissionConfigStatus.CANCELLED,
            cancelledAt: new Date(),
            cancelledBy: new Types.ObjectId(adminUserId),
          },
        },
        { returnDocument: "after" },
      )
      .exec();
    if (cancelled) return this.toView(cancelled, CommissionPhase.CANCELLED);
    const existing = await this.configModel.findById(id).exec();
    if (!existing) throw apiNotFound("Commission version not found", "COMMISSION_NOT_CONFIGURED");
    throw new ApiException(
      HttpStatus.CONFLICT,
      "Only a scheduled change that has not taken effect can be cancelled",
      "COMMISSION_NOT_CANCELLABLE",
    );
  }

  private async requireRideType(code: string): Promise<Pick<RideType, "code" | "displayName" | "isActive">> {
    const rideType = await this.rideTypeModel.findOne({ code }).select("code displayName isActive").lean().exec();
    if (!rideType) throw apiNotFound(`Ride type ${code} not found`, "RIDE_TYPE_NOT_FOUND");
    return rideType;
  }

  toView(config: CommissionConfigDocument, phase: CommissionPhase): CommissionView {
    return {
      id: config._id.toString(),
      rideType: config.rideType,
      version: config.version,
      type: config.type,
      value: config.value,
      effectiveFrom: config.effectiveFrom,
      status: config.status,
      phase,
      note: config.note,
      createdBy: config.createdBy?.toString(),
      createdAt: config.get("createdAt") as Date,
      cancelledAt: config.cancelledAt,
    };
  }
}
