import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, Types } from "mongoose";
import type { HydratedDocument } from "mongoose";

@Schema({ timestamps: { createdAt: true, updatedAt: false }, collection: "user_sessions" })
export class UserSession {
  @Prop({ required: true, type: SchemaTypes.ObjectId, ref: "User" })
  userId!: Types.ObjectId;

  // Only a hash is stored — a leaked database dump must not yield usable
  // refresh tokens (see spec §11).
  @Prop({ required: true })
  refreshTokenHash!: string;

  @Prop()
  deviceId?: string;

  @Prop()
  deviceType?: string;

  @Prop()
  deviceName?: string;

  @Prop()
  ipAddress?: string;

  @Prop({ required: true, default: true })
  isActive!: boolean;

  @Prop({ required: true })
  expiresAt!: Date;

  @Prop()
  lastUsedAt?: Date;
}

export type UserSessionDocument = HydratedDocument<UserSession>;
export const UserSessionSchema = SchemaFactory.createForClass(UserSession);

UserSessionSchema.index({ userId: 1, isActive: 1 });
// TTL cleanup: Mongo drops the document once expiresAt has passed.
UserSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
