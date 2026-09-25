import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import type { HydratedDocument } from "mongoose";

export enum OtpPurpose {
  PHONE_VERIFICATION = "PHONE_VERIFICATION",
  LOGIN = "LOGIN",
  RESET_PASSWORD = "RESET_PASSWORD",
}

@Schema({ timestamps: { createdAt: true, updatedAt: false }, collection: "otp_verifications" })
export class OtpVerification {
  @Prop({ required: true })
  phone!: string;

  @Prop({ required: true, enum: OtpPurpose })
  purpose!: OtpPurpose;

  @Prop({ required: true })
  otpHash!: string;

  @Prop({ required: true, default: 0 })
  attempts!: number;

  @Prop({ required: true, default: false })
  verified!: boolean;

  @Prop({ required: true })
  expiresAt!: Date;
}

export type OtpVerificationDocument = HydratedDocument<OtpVerification>;
export const OtpVerificationSchema =
  SchemaFactory.createForClass(OtpVerification);

OtpVerificationSchema.index({ phone: 1, purpose: 1, createdAt: -1 });
OtpVerificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
