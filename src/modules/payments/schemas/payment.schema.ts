import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, Types } from "mongoose";
import type { HydratedDocument } from "mongoose";
import {
  PAYMENT_GATEWAY,
  PaymentGateway,
  PaymentAttemptStatus,
  PaymentEventSource,
  PaymentStatus,
} from "../interfaces/payment-status";

/** One Razorpay order raised for this ride's bill. */
@Schema({ _id: false, timestamps: true })
export class PaymentAttempt {
  @Prop({ required: true })
  orderId!: string;

  @Prop({ required: true, min: 1 })
  amountPaise!: number;

  @Prop({ required: true, enum: PaymentAttemptStatus, default: PaymentAttemptStatus.CREATED })
  status!: PaymentAttemptStatus;

  /** Latest Razorpay payment seen on this order. */
  @Prop()
  razorpayPaymentId?: string;

  @Prop()
  failureCode?: string;

  @Prop()
  failureReason?: string;

  createdAt?: Date;
  updatedAt?: Date;
}
const PaymentAttemptSchema = SchemaFactory.createForClass(PaymentAttempt);

/** Non-sensitive instrument details reported by Razorpay (never card numbers, CVV, UPI PINs or VPAs). */
@Schema({ _id: false })
export class PaymentMethodDetails {
  @Prop()
  bank?: string;

  @Prop()
  wallet?: string;

  @Prop()
  cardNetwork?: string;

  @Prop()
  cardType?: string;

  /** Last four digits only, as Razorpay returns them. */
  @Prop()
  cardLast4?: string;
}
const PaymentMethodDetailsSchema = SchemaFactory.createForClass(PaymentMethodDetails);

/** Append-only audit line: what happened, who reported it, when. */
@Schema({ _id: false })
export class PaymentEvent {
  @Prop({ required: true })
  type!: string;

  @Prop({ required: true, enum: PaymentEventSource })
  source!: PaymentEventSource;

  @Prop({ required: true })
  at!: Date;

  @Prop()
  razorpayOrderId?: string;

  @Prop()
  razorpayPaymentId?: string;

  @Prop()
  detail?: string;
}
const PaymentEventSchema = SchemaFactory.createForClass(PaymentEvent);

/**
 * A second successful capture on an already-paid ride (the customer paid
 * twice from two devices). Never counted as revenue; flagged for a manual
 * refund in the Razorpay dashboard.
 */
@Schema({ _id: false })
export class DuplicateCapture {
  @Prop({ required: true })
  razorpayPaymentId!: string;

  @Prop()
  razorpayOrderId?: string;

  @Prop({ required: true })
  amountPaise!: number;

  @Prop({ required: true })
  detectedAt!: Date;
}
const DuplicateCaptureSchema = SchemaFactory.createForClass(DuplicateCapture);

/**
 * The bill for one completed ride (`rideId` is unique: one payment per
 * ride, however many attempts). The amount is the ride's server-calculated
 * final fare, in paise; nothing the app sends can change it.
 *
 * Stores Razorpay references only — never card numbers, CVV, UPI PIN or
 * bank credentials (Razorpay's hosted checkout collects those).
 */
@Schema({ timestamps: true, collection: "payments" })
export class Payment {
  @Prop({ required: true, type: SchemaTypes.ObjectId, ref: "Ride" })
  rideId!: Types.ObjectId;

  @Prop({ required: true })
  rideCode!: string;

  @Prop({ required: true, type: SchemaTypes.ObjectId, ref: "User" })
  customerId!: Types.ObjectId;

  @Prop({ required: true, type: SchemaTypes.ObjectId, ref: "DriverProfile" })
  driverId!: Types.ObjectId;

  @Prop({ required: true, type: SchemaTypes.ObjectId, ref: "User" })
  driverUserId!: Types.ObjectId;

  /** RAZORPAY, or CASH when the customer paid the driver directly. */
  @Prop({ required: true, enum: PaymentGateway, default: PAYMENT_GATEWAY })
  gateway!: PaymentGateway;

  // ── Money ─────────────────────────────────────────────────────────────
  @Prop({ required: true, min: 1 })
  amountPaise!: number;

  @Prop({ required: true, default: "INR" })
  currency!: string;

  @Prop({ required: true, enum: PaymentStatus, default: PaymentStatus.CREATED })
  status!: PaymentStatus;

  // ── Razorpay references ───────────────────────────────────────────────
  /** The order the next checkout opens (latest attempt). */
  @Prop()
  razorpayOrderId?: string;

  /** The captured payment (pay_…). Unique across all payments. */
  @Prop()
  razorpayPaymentId?: string;

  /** Checkout signature that verified the capture (when it came via /verify). */
  @Prop({ select: false })
  razorpaySignature?: string;

  /** From Razorpay, never from the app: upi | card | netbanking | wallet | … */
  @Prop()
  method?: string;

  @Prop({ type: PaymentMethodDetailsSchema })
  methodDetails?: PaymentMethodDetails;

  @Prop({ type: [PaymentAttemptSchema], default: [] })
  attempts!: PaymentAttempt[];

  // ── Outcome ───────────────────────────────────────────────────────────
  @Prop()
  failureCode?: string;

  @Prop()
  failureReason?: string;

  @Prop()
  paidAt?: Date;

  /**
   * Set while Razorpay has a payment we have not confirmed (verify could not
   * reach Razorpay, or an authorisation awaits capture). The reconciler
   * re-checks such payments.
   */
  @Prop()
  processingSince?: Date;

  @Prop()
  processingPaymentId?: string;

  // ── Refunds (synced from Razorpay; no refund workflow in V1) ──────────
  @Prop()
  refundId?: string;

  @Prop({ min: 0 })
  refundAmountPaise?: number;

  @Prop()
  refundStatus?: string;

  @Prop()
  refundedAt?: Date;

  @Prop({ type: [DuplicateCaptureSchema], default: [] })
  duplicateCaptures!: DuplicateCapture[];

  // ── Bookkeeping ───────────────────────────────────────────────────────
  @Prop({ type: SchemaTypes.ObjectId, ref: "DriverEarning" })
  earningId?: Types.ObjectId;

  /** Serialises order creation so double taps never raise two orders. */
  @Prop()
  orderLockUntil?: Date;

  @Prop()
  lastReconciledAt?: Date;

  @Prop({ type: [PaymentEventSchema], default: [] })
  events!: PaymentEvent[];
}

export type PaymentDocument = HydratedDocument<Payment>;
export const PaymentSchema = SchemaFactory.createForClass(Payment);

PaymentSchema.index({ rideId: 1 }, { unique: true, name: "uniq_payment_per_ride" });
// A Razorpay payment can settle exactly one Tirvona payment (rule: no reuse).
PaymentSchema.index(
  { razorpayPaymentId: 1 },
  {
    unique: true,
    partialFilterExpression: { razorpayPaymentId: { $type: "string" } },
    name: "uniq_razorpay_payment_id",
  },
);
PaymentSchema.index({ "attempts.orderId": 1 });
PaymentSchema.index({ customerId: 1, createdAt: -1 });
PaymentSchema.index({ driverId: 1, createdAt: -1 });
PaymentSchema.index({ status: 1, createdAt: -1 });
PaymentSchema.index({ createdAt: -1 });
// Reconciler scans.
PaymentSchema.index({ status: 1, processingSince: 1 });
PaymentSchema.index({ status: 1, earningId: 1 });
