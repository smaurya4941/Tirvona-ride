import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import type { HydratedDocument } from "mongoose";

export enum WebhookEventStatus {
  RECEIVED = "RECEIVED",
  PROCESSED = "PROCESSED",
  /** Valid but irrelevant (unknown order, unhandled event type). */
  IGNORED = "IGNORED",
  /** Valid but inconsistent with our records (e.g. amount mismatch) — needs a human. */
  FLAGGED = "FLAGGED",
  /** Processing threw; Razorpay's retry will process it again. */
  FAILED = "FAILED",
}

/**
 * Every verified Razorpay webhook delivery, keyed by Razorpay's event id.
 * Razorpay delivers at-least-once; this makes a redelivery a no-op and keeps
 * a trail of what the gateway told us.
 */
@Schema({ timestamps: true, collection: "payment_webhook_events" })
export class PaymentWebhookEvent {
  @Prop({ required: true })
  eventId!: string;

  @Prop({ required: true })
  event!: string;

  @Prop({ required: true, enum: WebhookEventStatus, default: WebhookEventStatus.RECEIVED })
  status!: WebhookEventStatus;

  @Prop()
  razorpayOrderId?: string;

  @Prop()
  razorpayPaymentId?: string;

  @Prop()
  detail?: string;

  @Prop({ default: 1 })
  deliveries!: number;
}

export type PaymentWebhookEventDocument = HydratedDocument<PaymentWebhookEvent>;
export const PaymentWebhookEventSchema = SchemaFactory.createForClass(PaymentWebhookEvent);

PaymentWebhookEventSchema.index({ eventId: 1 }, { unique: true });
// Webhook trail is operational data: keep 180 days.
PaymentWebhookEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 180 * 86_400, name: "ttl_180d" });
