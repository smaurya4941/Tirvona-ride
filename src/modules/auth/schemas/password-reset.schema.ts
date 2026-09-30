import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, Types } from "mongoose";
import type { HydratedDocument } from "mongoose";

/**
 * A verified forgot-password code, exchanged for a short-lived one-time
 * token: the app shows "choose a new password" only after the code was
 * right, and the password is set with this token — never with the code,
 * which is already consumed. Only the SHA-256 of the token is stored.
 *
 * At most one per user (a newer verification replaces it); redeeming it
 * deletes it, and the TTL index removes the ones nobody redeemed.
 */
@Schema({ collection: "password_resets", timestamps: true, versionKey: false })
export class PasswordReset {
  @Prop({ required: true, type: SchemaTypes.ObjectId, ref: "User" })
  userId!: Types.ObjectId;

  @Prop({ required: true })
  tokenHash!: string;

  @Prop({ required: true })
  expiresAt!: Date;
}

export type PasswordResetDocument = HydratedDocument<PasswordReset>;
export const PasswordResetSchema = SchemaFactory.createForClass(PasswordReset);

PasswordResetSchema.index({ userId: 1 }, { unique: true });
PasswordResetSchema.index({ tokenHash: 1 }, { unique: true });
PasswordResetSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
