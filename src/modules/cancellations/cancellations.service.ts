import { Injectable, Logger } from "@nestjs/common";
import type { OnModuleInit } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import type { Model, QueryFilter } from "mongoose";
import { Types } from "mongoose";
import { apiBadRequest, apiConflict, apiNotFound } from "../../common/exceptions/api.exception";
import { RideActorType } from "../rides/ride-state-machine";
import type { RideStatus } from "../rides/ride-state-machine";
import type { Page } from "../rides/rides.service";
import { Ride } from "../rides/schemas/ride.schema";
import { User } from "../users/schemas/user.schema";
import { DISABLED_CUSTOMER_FEE_RULE, assessCancellationFee } from "./cancellation-fee";
import type { CustomerFeeRule, FeeAssessment } from "./cancellation-fee";
import { DEFAULT_CANCELLATION_REASONS, OTHER_REASON_CODE } from "./cancellation-reasons.seed";
import type {
  CreateCancellationReasonDto,
  ListCancellationsQueryDto,
  UpdateCancellationPolicyDto,
  UpdateCancellationReasonDto,
} from "./dto/cancellation.dto";
import {
  Cancellation,
  CancellationFeeStatus,
  CancellationPolicy,
  CancellationReason,
} from "./schemas/cancellation.schemas";
import type { CancellationDocument, CancellationReasonDocument } from "./schemas/cancellation.schemas";

export interface CancellationReasonView {
  code: string;
  actor: RideActorType;
  label: string;
  requiresNote: boolean;
  isActive: boolean;
  sortOrder: number;
}

export interface CancellationPolicyView {
  version: number;
  customerFee: CustomerFeeRule;
  note?: string;
  createdAt?: Date;
}

export interface ResolvedReason {
  code: string;
  label: string;
  note?: string;
}

/** Everything the cancel sheet in the app needs before the user confirms. */
export interface CancellationPreview {
  cancellable: boolean;
  reasons: CancellationReasonView[];
  fee: FeeAssessment;
  currency: string;
}

/** The minimum a cancellation record needs to know about the ride. */
export interface CancelledRideFacts {
  _id: Types.ObjectId;
  rideCode: string;
  rideType: string;
  customerId: Types.ObjectId;
  driverId?: Types.ObjectId;
  zoneId?: Types.ObjectId;
  fare: { estimatedFare: number };
  cancelledAt?: Date;
}

export interface CancellationView {
  id: string;
  rideId: string;
  rideCode: string;
  rideType: string;
  customerId: string;
  customerName?: string;
  customerPhone?: string;
  driverId?: string;
  cancelledBy: RideActorType;
  reasonCode: string;
  reasonLabel: string;
  note?: string;
  rideStatusAtCancellation: RideStatus;
  estimatedFare: number;
  feeAmount: number;
  feeStatus: CancellationFeeStatus;
  policyVersion?: number;
  cancelledAt: Date;
  feeResolvedAt?: Date;
  feeResolutionNote?: string;
}

const isDuplicateKey = (error: unknown): boolean => (error as { code?: number } | undefined)?.code === 11000;
const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

@Injectable()
export class CancellationsService implements OnModuleInit {
  private readonly logger = new Logger(CancellationsService.name);

  constructor(
    @InjectModel(CancellationReason.name) private readonly reasonModel: Model<CancellationReason>,
    @InjectModel(CancellationPolicy.name) private readonly policyModel: Model<CancellationPolicy>,
    @InjectModel(Cancellation.name) private readonly cancellationModel: Model<Cancellation>,
    @InjectModel(Ride.name) private readonly rideModel: Model<Ride>,
    @InjectModel(User.name) private readonly userModel: Model<User>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.seedDefaults();
  }

  /** Idempotent; never overwrites an admin's edits. */
  async seedDefaults(): Promise<void> {
    for (const reason of DEFAULT_CANCELLATION_REASONS) {
      try {
        await this.reasonModel
          .updateOne({ actor: reason.actor, code: reason.code }, { $setOnInsert: { ...reason, isActive: true } }, { upsert: true })
          .exec();
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
      }
    }
    try {
      await this.policyModel
        .updateOne(
          { version: 1 },
          { $setOnInsert: { version: 1, customerFee: DISABLED_CUSTOMER_FEE_RULE, note: "Initial policy: no cancellation fees" } },
          { upsert: true },
        )
        .exec();
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
    }
  }

  // ── Reasons ───────────────────────────────────────────────────────────

  reasonView(reason: CancellationReasonDocument): CancellationReasonView {
    return {
      code: reason.code,
      actor: reason.actor,
      label: reason.label,
      requiresNote: reason.requiresNote,
      isActive: reason.isActive,
      sortOrder: reason.sortOrder,
    };
  }

  async listReasons(actor?: RideActorType, activeOnly = true): Promise<CancellationReasonView[]> {
    const filter: QueryFilter<CancellationReason> = {};
    if (actor) filter.actor = actor;
    if (activeOnly) filter.isActive = true;
    const reasons = await this.reasonModel.find(filter).sort({ actor: 1, sortOrder: 1, label: 1 }).exec();
    return reasons.map((reason) => this.reasonView(reason));
  }

  async createReason(dto: CreateCancellationReasonDto): Promise<CancellationReasonView> {
    try {
      const reason = await this.reasonModel.create({
        code: dto.code,
        actor: dto.actor,
        label: dto.label,
        requiresNote: dto.requiresNote ?? false,
        sortOrder: dto.sortOrder ?? 50,
        isActive: true,
      });
      return this.reasonView(reason);
    } catch (error) {
      if (isDuplicateKey(error))
        throw apiConflict(`Reason ${dto.code} already exists for ${dto.actor}`, "CANCELLATION_REASON_EXISTS");
      throw error;
    }
  }

  async updateReason(actor: RideActorType, code: string, dto: UpdateCancellationReasonDto): Promise<CancellationReasonView> {
    const reason = await this.reasonModel.findOne({ actor, code }).exec();
    if (!reason) throw apiNotFound("Cancellation reason not found", "CANCELLATION_REASON_NOT_FOUND");
    if (dto.isActive === false && code === OTHER_REASON_CODE)
      throw apiBadRequest("The 'Other' reason cannot be retired: older app versions rely on it", "VALIDATION_FAILED");
    if (dto.label !== undefined) reason.label = dto.label;
    if (dto.requiresNote !== undefined) reason.requiresNote = dto.requiresNote;
    if (dto.isActive !== undefined) reason.isActive = dto.isActive;
    if (dto.sortOrder !== undefined) reason.sortOrder = dto.sortOrder;
    await reason.save();
    return this.reasonView(reason);
  }

  /**
   * Validates the chosen reason for this actor. Older app builds send only
   * free text: that is recorded under OTHER so every cancellation still has
   * a controlled code for reporting.
   */
  async resolveReason(actor: RideActorType, reasonCode?: string, note?: string): Promise<ResolvedReason> {
    const code = reasonCode ?? OTHER_REASON_CODE;
    const reason = await this.reasonModel.findOne({ actor, code, isActive: true }).exec();
    if (!reason)
      throw apiBadRequest("Choose one of the listed cancellation reasons", "CANCELLATION_REASON_INVALID");
    const trimmed = note?.trim() || undefined;
    // Legacy clients (no reasonCode) may send nothing at all; don't break them.
    if (reason.requiresNote && !trimmed && reasonCode !== undefined)
      throw apiBadRequest("Please tell us briefly why you are cancelling", "CANCELLATION_REASON_INVALID");
    return { code: reason.code, label: reason.label, note: trimmed };
  }

  // ── Policy ────────────────────────────────────────────────────────────

  async currentPolicy(): Promise<CancellationPolicyView> {
    const policy = await this.policyModel.findOne().sort({ version: -1 }).lean().exec();
    if (!policy) return { version: 0, customerFee: DISABLED_CUSTOMER_FEE_RULE };
    return {
      version: policy.version,
      customerFee: { ...policy.customerFee, applicableStatuses: [...policy.customerFee.applicableStatuses] },
      note: policy.note,
      createdAt: policy.createdAt,
    };
  }

  async policyHistory(): Promise<CancellationPolicyView[]> {
    const rows = await this.policyModel.find().sort({ version: -1 }).limit(50).lean().exec();
    return rows.map((policy) => ({
      version: policy.version,
      customerFee: policy.customerFee,
      note: policy.note,
      createdAt: policy.createdAt,
    }));
  }

  async updatePolicy(dto: UpdateCancellationPolicyDto, adminUserId: string): Promise<CancellationPolicyView> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await this.currentPolicy();
      try {
        const created = await this.policyModel.create({
          version: current.version + 1,
          customerFee: dto.customerFee,
          note: dto.note,
          createdBy: new Types.ObjectId(adminUserId),
        });
        return {
          version: created.version,
          customerFee: created.customerFee,
          note: created.note,
          createdAt: created.createdAt,
        };
      } catch (error) {
        // Two admins saving at once: retry on top of the winner.
        if (!isDuplicateKey(error)) throw error;
      }
    }
    throw apiConflict("The policy changed while saving. Reload and retry.", "VALIDATION_FAILED");
  }

  // ── Assessment ────────────────────────────────────────────────────────

  async assess(input: {
    actor: RideActorType;
    status: RideStatus;
    acceptedAt?: Date;
    fare: number;
    now?: Date;
  }): Promise<FeeAssessment & { policyVersion: number }> {
    const policy = await this.currentPolicy();
    return {
      ...assessCancellationFee(policy.customerFee, {
        actor: input.actor,
        status: input.status,
        acceptedAt: input.acceptedAt,
        now: input.now ?? new Date(),
        fare: input.fare,
      }),
      policyVersion: policy.version,
    };
  }

  async preview(input: {
    actor: RideActorType;
    status: RideStatus;
    cancellable: boolean;
    acceptedAt?: Date;
    fare: number;
    currency: string;
  }): Promise<CancellationPreview> {
    const [reasons, fee] = await Promise.all([
      this.listReasons(input.actor),
      input.cancellable
        ? this.assess(input)
        : Promise.resolve<FeeAssessment>({ amount: 0, applies: false, explanation: "This ride can no longer be cancelled" }),
    ]);
    return {
      cancellable: input.cancellable,
      reasons,
      fee: { amount: fee.amount, applies: fee.applies, explanation: fee.explanation, freeUntil: fee.freeUntil },
      currency: input.currency,
    };
  }

  // ── Records ───────────────────────────────────────────────────────────

  /**
   * Writes the cancellation record after the ride's CANCELLED transition
   * committed. Idempotent per ride. A failure is logged, never surfaced: the
   * ride itself (which carries the same facts) is the source of record.
   */
  async record(
    ride: CancelledRideFacts,
    details: {
      cancelledBy: RideActorType;
      cancelledByUserId?: Types.ObjectId;
      reason: ResolvedReason;
      statusAtCancellation: RideStatus;
      feeAmount: number;
      policyVersion?: number;
    },
  ): Promise<void> {
    try {
      await this.cancellationModel.create({
        rideId: ride._id,
        rideCode: ride.rideCode,
        rideType: ride.rideType,
        customerId: ride.customerId,
        driverId: ride.driverId,
        zoneId: ride.zoneId,
        cancelledBy: details.cancelledBy,
        cancelledByUserId: details.cancelledByUserId,
        reasonCode: details.reason.code,
        reasonLabel: details.reason.label,
        note: details.reason.note,
        rideStatusAtCancellation: details.statusAtCancellation,
        estimatedFare: ride.fare.estimatedFare,
        feeAmount: details.feeAmount,
        feeStatus: details.feeAmount > 0 ? CancellationFeeStatus.DUE : CancellationFeeStatus.NOT_APPLICABLE,
        policyVersion: details.policyVersion,
        cancelledAt: ride.cancelledAt ?? new Date(),
      });
    } catch (error) {
      if (isDuplicateKey(error)) return;
      this.logger.error(
        `Could not record cancellation of ride ${ride.rideCode}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  async list(query: ListCancellationsQueryDto): Promise<Page<CancellationView>> {
    const filter: QueryFilter<Cancellation> = {};
    if (query.cancelledBy) filter.cancelledBy = query.cancelledBy;
    if (query.feeStatus) filter.feeStatus = query.feeStatus;
    if (query.reasonCode) filter.reasonCode = query.reasonCode;
    if (query.search) filter.rideCode = { $regex: `^${escapeRegex(query.search.trim().toUpperCase())}` };
    if (query.from || query.to)
      filter.cancelledAt = { ...(query.from ? { $gte: query.from } : {}), ...(query.to ? { $lt: query.to } : {}) };

    const [rows, total] = await Promise.all([
      this.cancellationModel
        .find(filter)
        .sort({ cancelledAt: -1, _id: -1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .exec(),
      this.cancellationModel.countDocuments(filter).exec(),
    ]);
    const customers = await this.userModel
      .find({ _id: { $in: rows.map((row) => row.customerId) } })
      .select("firstName lastName phone")
      .lean()
      .exec();
    const byId = new Map(customers.map((customer) => [customer._id.toString(), customer]));
    return {
      items: rows.map((row) => this.view(row, byId.get(row.customerId.toString()))),
      page: query.page,
      limit: query.limit,
      total,
      hasMore: query.page * query.limit < total,
    };
  }

  async findByRide(rideId: Types.ObjectId): Promise<CancellationView | null> {
    const row = await this.cancellationModel.findOne({ rideId }).exec();
    return row ? this.view(row) : null;
  }

  /** Outstanding (DUE) cancellation fees of one customer, rupees. */
  async outstandingFor(customerId: Types.ObjectId): Promise<{ count: number; amount: number }> {
    const [row] = await this.cancellationModel
      .aggregate<{ count: number; amount: number }>([
        { $match: { customerId, feeStatus: CancellationFeeStatus.DUE } },
        { $group: { _id: null, count: { $sum: 1 }, amount: { $sum: "$feeAmount" } } },
      ])
      .exec();
    return { count: row?.count ?? 0, amount: row?.amount ?? 0 };
  }

  /** Admin: waive a due fee, or mark it collected (e.g. paid to support). */
  async resolveFee(
    id: string,
    status: CancellationFeeStatus.WAIVED | CancellationFeeStatus.COLLECTED,
    note: string,
    adminUserId: string,
  ): Promise<CancellationView> {
    const updated = await this.cancellationModel
      .findOneAndUpdate(
        { _id: id, feeStatus: CancellationFeeStatus.DUE },
        {
          $set: {
            feeStatus: status,
            feeResolvedBy: new Types.ObjectId(adminUserId),
            feeResolvedAt: new Date(),
            feeResolutionNote: note,
          },
        },
        { returnDocument: "after" },
      )
      .exec();
    if (!updated) {
      const exists = await this.cancellationModel.exists({ _id: id });
      if (!exists) throw apiNotFound("Cancellation not found", "CANCELLATION_NOT_FOUND");
      throw apiConflict("This cancellation has no fee due", "CANCELLATION_FEE_NOT_DUE");
    }
    // Keep the ride's denormalised copy in step (what the customer app shows).
    await this.rideModel.updateOne({ _id: updated.rideId }, { $set: { "cancellation.feeStatus": status } }).exec();
    return this.view(updated);
  }

  view(row: CancellationDocument, customer?: { firstName?: string; lastName?: string; phone?: string } | null): CancellationView {
    return {
      id: row._id.toString(),
      rideId: row.rideId.toString(),
      rideCode: row.rideCode,
      rideType: row.rideType,
      customerId: row.customerId.toString(),
      customerName: customer ? [customer.firstName, customer.lastName].filter(Boolean).join(" ") : undefined,
      customerPhone: customer?.phone,
      driverId: row.driverId?.toString(),
      cancelledBy: row.cancelledBy,
      reasonCode: row.reasonCode,
      reasonLabel: row.reasonLabel,
      note: row.note,
      rideStatusAtCancellation: row.rideStatusAtCancellation,
      estimatedFare: row.estimatedFare,
      feeAmount: row.feeAmount,
      feeStatus: row.feeStatus,
      policyVersion: row.policyVersion,
      cancelledAt: row.cancelledAt,
      feeResolvedAt: row.feeResolvedAt,
      feeResolutionNote: row.feeResolutionNote,
    };
  }
}
