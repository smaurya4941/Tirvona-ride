import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import type { HydratedDocument } from "mongoose";

export enum OtpPurpose {
  /** New-account signup: the account is created only once this code is verified. */
  SIGNUP = "SIGNUP",
  /** A signed-in account created before signup OTP existed proving its number. */
  PHONE_VERIFICATION = "PHONE_VERIFICATION",
  /** Forgot password: proves the account's number before a new password is set. */
  RESET_PASSWORD = "RESET_PASSWORD",
  // Reserved for a later flow; nothing issues it yet.
  LOGIN = "LOGIN",
}

/**
 * The single active code for one (phone, purpose). Issuing a new code
 * overwrites the hash, so a resend makes every earlier code worthless; a
 * successful verification deletes the record at once. The TTL index is only
 * cleanup — OtpService checks expiresAt itself, because Mongo's TTL monitor
 * runs about once a minute.
 *
 * Only an HMAC of the code is stored (see OtpService), never the code.
 */
@Schema({ collection: "otp_verifications", timestamps: false, versionKey: false })
export class OtpVerification {
  @Prop({ required: true })
  phone!: string;

  @Prop({ required: true, enum: OtpPurpose })
  purpose!: OtpPurpose;

  @Prop({ required: true })
  otpHash!: string;

  @Prop({ required: true })
  expiresAt!: Date;

  @Prop({ required: true, default: 0 })
  attempts!: number;

  /** Claimed by a successful verification (the record is deleted right after). */
  @Prop({ required: true, default: false })
  verified!: boolean;

  /** When this code was issued (a resend resets it). */
  @Prop({ required: true })
  createdAt!: Date;
}

export type OtpVerificationDocument = HydratedDocument<OtpVerification>;
export const OtpVerificationSchema = SchemaFactory.createForClass(OtpVerification);

// One active code per phone and purpose — the lookup for verify and resend.
OtpVerificationSchema.index({ phone: 1, purpose: 1 }, { unique: true });
// TTL cleanup of expired codes.
OtpVerificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
