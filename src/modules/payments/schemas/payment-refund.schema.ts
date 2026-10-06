import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, Types } from "mongoose";
import type { HydratedDocument } from "mongoose";
import {
  RefundDriverImpact,
  RefundLedgerState,
  RefundReason,
  RefundSource,
  RefundStatus,
  RefundTarget,
} from "../interfaces/refund-status";

/**
 * One refund of a captured Razorpay payment — full or partial, of the ride's
 * payment or of a duplicate capture. A payment can have several (partial)
 * refunds; the payment's own refund totals are always recomputed from this
 * collection, never incremented, so a repeated or reordered update cannot
 * drift them.
 *
 * `idempotencyKey` is unique: the admin's retry of the same request returns
 * the same refund. `razorpayRefundId` is unique: one Razorpay refund maps to
 * one record however many webhooks report it.
 */
@Schema({ timestamps: true, collection: "payment_refunds" })
export class PaymentRefund {
  @Prop({ required: true, type: SchemaTypes.ObjectId, ref: "Payment" })
  paymentId!: Types.ObjectId;

  @Prop({ required: true, type: SchemaTypes.ObjectId, ref: "Ride" })
  rideId!: Types.ObjectId;

  @Prop({ required: true })
  rideCode!: string;

  @Prop({ required: true, type: SchemaTypes.ObjectId, ref: "User" })
  customerId!: Types.ObjectId;

  @Prop({ required: true, type: SchemaTypes.ObjectId, ref: "DriverProfile" })
  driverId!: Types.ObjectId;

  @Prop({ required: true, enum: RefundTarget, default: RefundTarget.PAYMENT })
  target!: RefundTarget;

  /** The captured Razorpay payment the money goes back from (pay_…). */
  @Prop({ required: true })
  razorpayPaymentId!: string;

  @Prop({ required: true, min: 1 })
  amountPaise!: number;

  @Prop({ required: true, default: "INR" })
  currency!: string;

  @Prop({ required: true, enum: RefundReason })
  reason!: RefundReason;

  @Prop({ trim: true })
  note?: string;

  @Prop({ required: true, enum: RefundDriverImpact })
  driverImpact!: RefundDriverImpact;

  @Prop({ required: true, enum: RefundStatus, default: RefundStatus.REQUESTED })
  status!: RefundStatus;

  @Prop()
  razorpayRefundId?: string;

  /** normal | optimum — Razorpay's processing speed. */
  @Prop()
  speedProcessed?: string;

  /** Bank reference once processed (ARN/RRN), for "where is my refund?". */
  @Prop()
  acquirerReference?: string;

  @Prop()
  failureReason?: string;

  @Prop({ required: true, enum: RefundSource })
  source!: RefundSource;

  @Prop({ type: SchemaTypes.ObjectId, ref: "User" })
  requestedBy?: Types.ObjectId;

  /** Client-supplied key for the admin request (unique when present). */
  @Prop()
  idempotencyKey?: string;

  @Prop()
  processedAt?: Date;

  @Prop()
  failedAt?: Date;

  /** Last time the reconciler asked Razorpay about this refund. */
  @Prop()
  lastCheckedAt?: Date;

  // ── Driver ledger ─────────────────────────────────────────────────────
  @Prop({
    required: true,
    enum: RefundLedgerState,
    default: RefundLedgerState.PENDING,
  })
  ledgerState!: RefundLedgerState;

  @Prop({ type: SchemaTypes.ObjectId, ref: "DriverEarningAdjustment" })
  adjustmentId?: Types.ObjectId;

  /** Dashboard refunds need a human to decide on the driver's earning. */
  @Prop({ default: false })
  needsReview!: boolean;

  createdAt?: Date;
  updatedAt?: Date;
}

export type PaymentRefundDocument = HydratedDocument<PaymentRefund>;
export const PaymentRefundSchema = SchemaFactory.createForClass(PaymentRefund);

PaymentRefundSchema.index({ paymentId: 1, createdAt: 1 });
PaymentRefundSchema.index(
  { razorpayRefundId: 1 },
  {
    unique: true,
    partialFilterExpression: { razorpayRefundId: { $type: "string" } },
    name: "uniq_razorpay_refund_id",
  },
);
PaymentRefundSchema.index(
  { idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: { idempotencyKey: { $type: "string" } },
    name: "uniq_refund_idempotency_key",
  },
);
// Reconciler sweeps and admin lists.
PaymentRefundSchema.index({ status: 1, updatedAt: 1 });
PaymentRefundSchema.index({ ledgerState: 1, status: 1 });
PaymentRefundSchema.index({ createdAt: -1 });
PaymentRefundSchema.index({ razorpayPaymentId: 1 });
