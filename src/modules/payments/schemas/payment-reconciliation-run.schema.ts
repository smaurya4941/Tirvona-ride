import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, Types } from "mongoose";
import type { HydratedDocument } from "mongoose";

export enum ReconciliationRunStatus {
  RUNNING = "RUNNING",
  COMPLETED = "COMPLETED",
  FAILED = "FAILED",
}

export enum ReconciliationTrigger {
  ADMIN = "ADMIN",
  DAILY = "DAILY",
}

/** What disagreed between Razorpay and MongoDB. */
export enum ReconciliationExceptionType {
  /** Razorpay captured money for a Ride payment we do not show as paid. */
  GATEWAY_PAID_NOT_RECORDED = "GATEWAY_PAID_NOT_RECORDED",
  /** We show a payment paid that Razorpay does not show captured. */
  RECORDED_PAID_NOT_AT_GATEWAY = "RECORDED_PAID_NOT_AT_GATEWAY",
  /** Razorpay's amount or currency differs from the ride's bill. */
  AMOUNT_MISMATCH = "AMOUNT_MISMATCH",
  /** A second capture on a paid ride that was not yet flagged. */
  UNTRACKED_DUPLICATE = "UNTRACKED_DUPLICATE",
  /** Razorpay's refunded amount differs from our refund records. */
  REFUND_MISMATCH = "REFUND_MISMATCH",
  /** An authorisation never captured (Razorpay auto-refunds it). */
  AUTHORIZED_NOT_CAPTURED = "AUTHORIZED_NOT_CAPTURED",
  /** A Ride-tagged Razorpay payment whose order we have no record of. */
  UNKNOWN_ORDER = "UNKNOWN_ORDER",
}

export enum ReconciliationSeverity {
  CRITICAL = "CRITICAL",
  WARNING = "WARNING",
  INFO = "INFO",
}

@Schema({ _id: true, timestamps: false })
export class ReconciliationException {
  _id!: Types.ObjectId;

  @Prop({ required: true, enum: ReconciliationExceptionType })
  type!: ReconciliationExceptionType;

  @Prop({ required: true, enum: ReconciliationSeverity })
  severity!: ReconciliationSeverity;

  @Prop({ type: SchemaTypes.ObjectId, ref: "Payment" })
  paymentId?: Types.ObjectId;

  @Prop()
  rideCode?: string;

  @Prop()
  razorpayPaymentId?: string;

  @Prop()
  razorpayOrderId?: string;

  /** Our side, e.g. "CREATED 16800p". */
  @Prop()
  expected?: string;

  /** Razorpay's side, e.g. "captured 16800p". */
  @Prop()
  actual?: string;

  @Prop({ required: true })
  detail!: string;

  /** The run fixed it itself (re-applied Razorpay's facts through the normal paths). */
  @Prop({ required: true, default: false })
  healed!: boolean;

  @Prop()
  resolvedAt?: Date;

  @Prop({ type: SchemaTypes.ObjectId, ref: "User" })
  resolvedBy?: Types.ObjectId;

  @Prop()
  resolutionNote?: string;
}
const ReconciliationExceptionSchema = SchemaFactory.createForClass(
  ReconciliationException,
);

@Schema({ _id: false })
export class ReconciliationStats {
  @Prop({ default: 0 }) gatewayPayments!: number;
  @Prop({ default: 0 }) ridePayments!: number;
  @Prop({ default: 0 }) foreignPayments!: number;
  @Prop({ default: 0 }) matched!: number;
  @Prop({ default: 0 }) recordedChecked!: number;
  @Prop({ default: 0 }) exceptions!: number;
  @Prop({ default: 0 }) healed!: number;
  /** Paise captured at Razorpay for Ride payments in the window. */
  @Prop({ default: 0 }) gatewayCapturedPaise!: number;
  /** Paise we recorded as captured (online) in the window. */
  @Prop({ default: 0 }) recordedCapturedPaise!: number;
}
const ReconciliationStatsSchema =
  SchemaFactory.createForClass(ReconciliationStats);

/**
 * One Razorpay ↔ MongoDB comparison over a time window: every Razorpay
 * payment created in the window that belongs to Tirvona Ride, and every
 * online payment we recorded as paid in it. Disagreements become exceptions;
 * the safe ones are healed through the normal settlement paths.
 */
@Schema({ timestamps: true, collection: "payment_reconciliation_runs" })
export class PaymentReconciliationRun {
  /** Unique: "daily:2026-09-28" (one automatic run per day) or "admin:<id>". */
  @Prop({ required: true })
  key!: string;

  @Prop({ required: true, enum: ReconciliationTrigger })
  trigger!: ReconciliationTrigger;

  @Prop({ required: true })
  from!: Date;

  @Prop({ required: true })
  to!: Date;

  @Prop({
    required: true,
    enum: ReconciliationRunStatus,
    default: ReconciliationRunStatus.RUNNING,
  })
  status!: ReconciliationRunStatus;

  @Prop({ type: SchemaTypes.ObjectId, ref: "User" })
  startedBy?: Types.ObjectId;

  @Prop({ required: true })
  startedAt!: Date;

  @Prop()
  finishedAt?: Date;

  @Prop({ type: ReconciliationStatsSchema, default: () => ({}) })
  stats!: ReconciliationStats;

  @Prop({ type: [ReconciliationExceptionSchema], default: [] })
  exceptions!: ReconciliationException[];

  /** More exceptions than stored, or Razorpay's list was cut at the page limit. */
  @Prop({ default: false })
  truncated!: boolean;

  @Prop()
  error?: string;
}

export type PaymentReconciliationRunDocument =
  HydratedDocument<PaymentReconciliationRun>;
export const PaymentReconciliationRunSchema = SchemaFactory.createForClass(
  PaymentReconciliationRun,
);

PaymentReconciliationRunSchema.index({ key: 1 }, { unique: true });
PaymentReconciliationRunSchema.index({ startedAt: -1 });
PaymentReconciliationRunSchema.index({ status: 1, startedAt: -1 });
