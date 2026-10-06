import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, Types } from "mongoose";
import type { HydratedDocument } from "mongoose";
import { RideActorType, RideStatus } from "../../rides/ride-state-machine";

export enum CancellationFeeStatus {
  NOT_APPLICABLE = "NOT_APPLICABLE",
  /** Owed by the customer. Collected manually in V1 (see docs/phase-7). */
  DUE = "DUE",
  WAIVED = "WAIVED",
  COLLECTED = "COLLECTED",
}

// ── Reasons ─────────────────────────────────────────────────────────────

/** A controlled cancellation reason. Codes are stable; labels are editable. */
@Schema({ timestamps: true, collection: "cancellation_reasons" })
export class CancellationReason {
  @Prop({ required: true, match: /^[A-Z][A-Z0-9_]{1,39}$/, immutable: true })
  code!: string;

  /** CUSTOMER | DRIVER | ADMIN — who may pick it. */
  @Prop({ required: true, enum: RideActorType, immutable: true })
  actor!: RideActorType;

  @Prop({ required: true, trim: true })
  label!: string;

  /** "Other"-style reasons need a short note. */
  @Prop({ required: true, default: false })
  requiresNote!: boolean;

  @Prop({ required: true, default: true })
  isActive!: boolean;

  @Prop({ required: true, default: 0 })
  sortOrder!: number;
}

export type CancellationReasonDocument = HydratedDocument<CancellationReason>;
export const CancellationReasonSchema =
  SchemaFactory.createForClass(CancellationReason);
CancellationReasonSchema.index({ actor: 1, code: 1 }, { unique: true });
CancellationReasonSchema.index({ actor: 1, isActive: 1, sortOrder: 1 });

// ── Fee policy (versioned) ──────────────────────────────────────────────

@Schema({ _id: false })
export class CustomerFeePolicy {
  @Prop({ required: true, default: false })
  enabled!: boolean;

  @Prop({ required: true, min: 0, default: 0 })
  graceSeconds!: number;

  @Prop({ required: true, min: 0, default: 0 })
  fixedFee!: number;

  @Prop({ required: true, min: 0, max: 100, default: 0 })
  percentOfFare!: number;

  @Prop({ required: true, min: 0, default: 0 })
  maxFee!: number;

  @Prop({ type: [String], enum: RideStatus, default: [] })
  applicableStatuses!: RideStatus[];
}
const CustomerFeePolicySchema = SchemaFactory.createForClass(CustomerFeePolicy);

/**
 * Every change is a new version (like commission): cancellations record the
 * version that priced them, so a later policy change never rewrites history.
 */
@Schema({
  timestamps: { createdAt: true, updatedAt: false },
  collection: "cancellation_policies",
})
export class CancellationPolicy {
  @Prop({ required: true, immutable: true })
  version!: number;

  @Prop({ required: true, type: CustomerFeePolicySchema })
  customerFee!: CustomerFeePolicy;

  @Prop({ type: SchemaTypes.ObjectId, ref: "User" })
  createdBy?: Types.ObjectId;

  @Prop({ trim: true })
  note?: string;

  createdAt?: Date;
}

export type CancellationPolicyDocument = HydratedDocument<CancellationPolicy>;
export const CancellationPolicySchema =
  SchemaFactory.createForClass(CancellationPolicy);
CancellationPolicySchema.index({ version: -1 }, { unique: true });

// ── Cancellation records ────────────────────────────────────────────────

/** One per cancelled ride: who, why, in which state, and what it cost. */
@Schema({ timestamps: true, collection: "cancellations" })
export class Cancellation {
  @Prop({
    required: true,
    type: SchemaTypes.ObjectId,
    ref: "Ride",
    immutable: true,
  })
  rideId!: Types.ObjectId;

  @Prop({ required: true, immutable: true })
  rideCode!: string;

  @Prop({ required: true, immutable: true })
  rideType!: string;

  @Prop({
    required: true,
    type: SchemaTypes.ObjectId,
    ref: "User",
    immutable: true,
  })
  customerId!: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: "DriverProfile", immutable: true })
  driverId?: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: "Zone", immutable: true })
  zoneId?: Types.ObjectId;

  @Prop({ required: true, enum: RideActorType, immutable: true })
  cancelledBy!: RideActorType;

  @Prop({ type: SchemaTypes.ObjectId, ref: "User", immutable: true })
  cancelledByUserId?: Types.ObjectId;

  @Prop({ required: true, immutable: true })
  reasonCode!: string;

  @Prop({ required: true, immutable: true })
  reasonLabel!: string;

  @Prop({ trim: true, immutable: true })
  note?: string;

  @Prop({ required: true, enum: RideStatus, immutable: true })
  rideStatusAtCancellation!: RideStatus;

  @Prop({ required: true, min: 0, immutable: true })
  estimatedFare!: number;

  /** Assessed fee, rupees (0 when none). */
  @Prop({ required: true, min: 0, default: 0, immutable: true })
  feeAmount!: number;

  @Prop({ required: true, enum: CancellationFeeStatus })
  feeStatus!: CancellationFeeStatus;

  @Prop({ immutable: true })
  policyVersion?: number;

  @Prop({ required: true, immutable: true })
  cancelledAt!: Date;

  // Fee resolution (admin)
  @Prop({ type: SchemaTypes.ObjectId, ref: "User" })
  feeResolvedBy?: Types.ObjectId;

  @Prop()
  feeResolvedAt?: Date;

  @Prop({ trim: true })
  feeResolutionNote?: string;
}

export type CancellationDocument = HydratedDocument<Cancellation>;
export const CancellationSchema = SchemaFactory.createForClass(Cancellation);
CancellationSchema.index({ rideId: 1 }, { unique: true });
CancellationSchema.index({ cancelledAt: -1 });
CancellationSchema.index({ cancelledBy: 1, cancelledAt: -1 });
CancellationSchema.index({ reasonCode: 1, cancelledAt: -1 });
CancellationSchema.index({ feeStatus: 1, cancelledAt: -1 });
CancellationSchema.index({ customerId: 1, feeStatus: 1 });
