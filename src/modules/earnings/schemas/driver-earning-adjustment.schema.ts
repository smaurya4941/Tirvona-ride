import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, Types } from "mongoose";
import type { HydratedDocument } from "mongoose";
import { AdjustmentStatus, AdjustmentType } from "../interfaces/earning-status";

/**
 * A correction to a driver's earnings that happened after the ride's ledger
 * line was written — today, the driver's share of a customer refund.
 *
 * Earning lines are immutable, so a refund never edits one; it adds an
 * adjustment instead, with the reversal computed at the refunded fraction of
 * that line's own snapshot (commission rate included). An OUTSTANDING
 * adjustment is deducted from the driver's next manual payout (SETTLED), or
 * written off by an admin (WAIVED).
 *
 * `refundId` is unique: a refund that is reported processed several times
 * (admin call, webhook, reconciler) claws back exactly once.
 */
@Schema({ timestamps: true, collection: "driver_earning_adjustments" })
export class DriverEarningAdjustment {
  @Prop({
    required: true,
    type: SchemaTypes.ObjectId,
    ref: "DriverProfile",
    immutable: true,
  })
  driverId!: Types.ObjectId;

  @Prop({
    required: true,
    type: SchemaTypes.ObjectId,
    ref: "User",
    immutable: true,
  })
  driverUserId!: Types.ObjectId;

  @Prop({
    required: true,
    type: SchemaTypes.ObjectId,
    ref: "DriverEarning",
    immutable: true,
  })
  earningId!: Types.ObjectId;

  @Prop({
    required: true,
    type: SchemaTypes.ObjectId,
    ref: "Ride",
    immutable: true,
  })
  rideId!: Types.ObjectId;

  @Prop({
    required: true,
    type: SchemaTypes.ObjectId,
    ref: "Payment",
    immutable: true,
  })
  paymentId!: Types.ObjectId;

  @Prop({
    required: true,
    type: SchemaTypes.ObjectId,
    ref: "PaymentRefund",
    immutable: true,
  })
  refundId!: Types.ObjectId;

  @Prop({ required: true, immutable: true })
  rideCode!: string;

  @Prop({ required: true, enum: AdjustmentType, immutable: true })
  type!: AdjustmentType;

  /** The refund reason (RefundReason), for the driver's statement. */
  @Prop({ required: true, immutable: true })
  reason!: string;

  @Prop({ required: true, default: "INR", immutable: true })
  currency!: string;

  // ── Money (paise, all ≥ 0) ────────────────────────────────────────────
  @Prop({ required: true, min: 0, immutable: true })
  refundAmountPaise!: number;

  /** Customer money returned, as a share of the earning's gross fare. */
  @Prop({ required: true, min: 0, immutable: true })
  grossReversalPaise!: number;

  /** Tirvona's commission given back on the refunded part. */
  @Prop({ required: true, min: 0, immutable: true })
  commissionReversalPaise!: number;

  /** Deducted from the driver: grossReversal − commissionReversal. */
  @Prop({ required: true, min: 0, immutable: true })
  amountPaise!: number;

  /** The rate on the earning line this reverses (for the statement). */
  @Prop({ required: true, min: 0, max: 100, immutable: true })
  commissionRate!: number;

  // ── Recovery lifecycle ────────────────────────────────────────────────
  @Prop({
    required: true,
    enum: AdjustmentStatus,
    default: AdjustmentStatus.OUTSTANDING,
  })
  status!: AdjustmentStatus;

  @Prop({ type: SchemaTypes.ObjectId, ref: "DriverPayout" })
  payoutId?: Types.ObjectId;

  @Prop()
  settledAt?: Date;

  @Prop({ type: SchemaTypes.ObjectId, ref: "User" })
  waivedBy?: Types.ObjectId;

  @Prop({ trim: true })
  waiverNote?: string;
}

export type DriverEarningAdjustmentDocument =
  HydratedDocument<DriverEarningAdjustment>;
export const DriverEarningAdjustmentSchema = SchemaFactory.createForClass(
  DriverEarningAdjustment,
);

DriverEarningAdjustmentSchema.index(
  { refundId: 1 },
  { unique: true, name: "uniq_adjustment_per_refund" },
);
DriverEarningAdjustmentSchema.index({ driverId: 1, status: 1, createdAt: 1 });
DriverEarningAdjustmentSchema.index({ earningId: 1 });
DriverEarningAdjustmentSchema.index({ payoutId: 1 }, { sparse: true });
