import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import type { HydratedDocument } from "mongoose";
import { UserRole } from "../../../common/types/user-role.enum";

/**
 * A submitted sign-up form waiting for its WhatsApp code. No user exists
 * until the code is verified, so an unverified number never occupies the
 * users collection (and cannot block the real owner from signing up).
 *
 * `verificationIdHash` ties the OTP to *this* submission: whoever submits
 * the form again for the same number replaces it and rotates the id, so a
 * stranger cannot slip their own password under the owner's code.
 */
@Schema({ collection: "pending_signups", timestamps: true, versionKey: false })
export class PendingSignup {
  @Prop({ required: true })
  phone!: string;

  @Prop({ required: true })
  verificationIdHash!: string;

  @Prop({ required: true, trim: true })
  firstName!: string;

  @Prop({ trim: true })
  lastName?: string;

  @Prop({ trim: true, lowercase: true })
  email?: string;

  /** argon2 — the plain password never touches the database. */
  @Prop({ required: true })
  passwordHash!: string;

  @Prop({ required: true, enum: [UserRole.CUSTOMER, UserRole.DRIVER] })
  role!: UserRole;

  @Prop()
  ipAddress?: string;

  @Prop({ required: true })
  expiresAt!: Date;
}

export type PendingSignupDocument = HydratedDocument<PendingSignup>;
export const PendingSignupSchema = SchemaFactory.createForClass(PendingSignup);

PendingSignupSchema.index({ phone: 1 }, { unique: true });
PendingSignupSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
