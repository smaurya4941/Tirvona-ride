import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import type { HydratedDocument } from "mongoose";
import { OtpPurpose } from "./otp-verification.schema";

/**
 * How many codes one phone number has been sent in the current window, and
 * when the last one went out. Kept apart from the OTP record because that
 * record disappears after 5 minutes, while the send budget must outlive it —
 * otherwise waiting out one code would reset the limit.
 *
 * MongoDB-backed on purpose (no Redis in V1); the per-IP limits in
 * ThrottlePolicy sit in front of it.
 */
@Schema({ collection: "otp_send_quotas", timestamps: false, versionKey: false })
export class OtpSendQuota {
  @Prop({ required: true })
  phone!: string;

  @Prop({ required: true, enum: OtpPurpose })
  purpose!: OtpPurpose;

  @Prop({ required: true, default: 0 })
  sendCount!: number;

  @Prop({ required: true })
  windowStartedAt!: Date;

  /** End of the window; the TTL index drops the quota afterwards. */
  @Prop({ required: true })
  expiresAt!: Date;

  /** Last accepted send — the resend cooldown runs from here. */
  @Prop()
  lastSentAt?: Date;
}

export type OtpSendQuotaDocument = HydratedDocument<OtpSendQuota>;
export const OtpSendQuotaSchema = SchemaFactory.createForClass(OtpSendQuota);

OtpSendQuotaSchema.index({ phone: 1, purpose: 1 }, { unique: true });
OtpSendQuotaSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
