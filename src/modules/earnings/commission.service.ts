import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import type { OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectModel } from "@nestjs/mongoose";
import type { Model } from "mongoose";
import { Types } from "mongoose";
import { ApiException, apiBadRequest, apiNotFound } from "../../common/exceptions/api.exception";
import type { UpdateCommissionDto } from "./dto/commission.dto";
import { CommissionConfigStatus, CommissionPhase, CommissionType } from "./interfaces/earning-status";
import type { CommissionView } from "./interfaces/earning-views";
import { CommissionConfig } from "./schemas/commission-config.schema";
import type { CommissionConfigDocument } from "./schemas/commission-config.schema";

const isDuplicateKey = (error: unknown): boolean => (error as { code?: number } | undefined)?.code === 11000;

// A change may be back-dated by at most this much (clock skew between the
// admin's browser and the server), never further: history is not rewritable.
const BACKDATE_TOLERANCE_MS = 5 * 60_000;

/**
 * Versioned commission settings. Admin edits append a version; the ledger
 * captures the rate in force when each earning is written, so historical
 * earnings never change when the rate does.
 */
@Injectable()
export class CommissionService implements OnModuleInit {
  private readonly logger = new Logger(CommissionService.name);
  private readonly defaultPercent: number;

  constructor(
    @InjectModel(CommissionConfig.name) private readonly configModel: Model<CommissionConfig>,
    config: ConfigService,
  ) {
    this.defaultPercent = config.getOrThrow<number>("defaultCommissionPercent");
  }

  async onModuleInit(): Promise<void> {
    await this.seedDefault();
  }

  /** First boot only: version 1 from DEFAULT_COMMISSION_PERCENT. */
  async seedDefault(): Promise<void> {
    try {
      const result = await this.configModel
        .updateOne(
          { version: 1 },
          {
            $setOnInsert: {
              version: 1,
              type: CommissionType.PERCENTAGE,
              value: this.defaultPercent,
              effectiveFrom: new Date(),
              status: CommissionConfigStatus.ACTIVE,
              note: "Initial commission",
            },
          },
          { upsert: true },
        )
        .exec();
      if (result.upsertedCount > 0) this.logger.log(`Seeded commission v1 at ${this.defaultPercent}%`);
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
    }
  }

  /** The version in force at `at` (default now). */
  async effectiveAt(at: Date = new Date()): Promise<CommissionConfigDocument> {
    const config = await this.configModel
      .findOne({ status: CommissionConfigStatus.ACTIVE, effectiveFrom: { $lte: at } })
      .sort({ effectiveFrom: -1, version: -1 })
      .exec();
    if (!config)
      throw new ApiException(
        HttpStatus.SERVICE_UNAVAILABLE,
        "No commission rate is configured",
        "COMMISSION_NOT_CONFIGURED",
      );
    return config;
  }

  async current(): Promise<{ current: CommissionView; scheduled: CommissionView[] }> {
    const now = new Date();
    const [current, scheduled] = await Promise.all([
      this.effectiveAt(now),
      this.configModel
        .find({ status: CommissionConfigStatus.ACTIVE, effectiveFrom: { $gt: now } })
        .sort({ effectiveFrom: 1, version: 1 })
        .exec(),
    ]);
    return {
      current: this.toView(current, CommissionPhase.CURRENT),
      scheduled: scheduled.map((entry) => this.toView(entry, CommissionPhase.SCHEDULED)),
    };
  }

  /** Newest first, each labelled SCHEDULED / CURRENT / SUPERSEDED / CANCELLED. */
  async history(): Promise<CommissionView[]> {
    const now = new Date();
    const [all, current] = await Promise.all([
      this.configModel.find().sort({ effectiveFrom: -1, version: -1 }).limit(200).exec(),
      this.effectiveAt(now).catch(() => null),
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

  /** Appends a new version; the previous one stays in history untouched. */
  async update(dto: UpdateCommissionDto, adminUserId: string): Promise<CommissionView> {
    const now = Date.now();
    const effectiveFrom = dto.effectiveFrom ? new Date(dto.effectiveFrom) : new Date(now);
    if (Number.isNaN(effectiveFrom.getTime()))
      throw apiBadRequest("effectiveFrom must be a valid date", "VALIDATION_FAILED");
    if (effectiveFrom.getTime() < now - BACKDATE_TOLERANCE_MS)
      throw apiBadRequest(
        "A commission change cannot take effect in the past — earnings already recorded keep their rate",
        "VALIDATION_FAILED",
      );

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const latest = await this.configModel.findOne().sort({ version: -1 }).select("version").lean().exec();
      try {
        const created = await this.configModel.create({
          version: (latest?.version ?? 0) + 1,
          type: dto.type ?? CommissionType.PERCENTAGE,
          value: dto.value,
          effectiveFrom,
          status: CommissionConfigStatus.ACTIVE,
          note: dto.note,
          createdBy: new Types.ObjectId(adminUserId),
        });
        this.logger.log(
          `Commission v${created.version} = ${created.value}% from ${effectiveFrom.toISOString()} by ${adminUserId}`,
        );
        return this.toView(
          created,
          effectiveFrom.getTime() > Date.now() ? CommissionPhase.SCHEDULED : CommissionPhase.CURRENT,
        );
      } catch (error) {
        // Two admins saving at once: retry with the next version number.
        if (!isDuplicateKey(error)) throw error;
      }
    }
    throw new ApiException(HttpStatus.CONFLICT, "Commission changed concurrently. Retry.", "VALIDATION_FAILED");
  }

  /** Withdraws a scheduled change. Versions already in force cannot be cancelled. */
  async cancelScheduled(id: string, adminUserId: string): Promise<CommissionView> {
    const cancelled = await this.configModel
      .findOneAndUpdate(
        { _id: id, status: CommissionConfigStatus.ACTIVE, effectiveFrom: { $gt: new Date() } },
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

  toView(config: CommissionConfigDocument, phase: CommissionPhase): CommissionView {
    return {
      id: config._id.toString(),
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
