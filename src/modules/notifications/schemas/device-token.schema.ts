import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, Types } from "mongoose";
import type { HydratedDocument } from "mongoose";

export enum DevicePlatform {
  ANDROID = "ANDROID",
  IOS = "IOS",
}

/** Why a token stopped receiving pushes (kept for support/debugging). */
export enum DeviceTokenDeactivation {
  LOGOUT = "LOGOUT",
  REPLACED = "REPLACED",
  REASSIGNED = "REASSIGNED",
  UNREGISTERED = "UNREGISTERED",
  LIMIT = "LIMIT",
}

/**
 * One FCM registration token per row. A user has one per phone/tablet; a
 * token belongs to exactly one user at a time (the device's current login).
 * Tokens are deactivated, never deleted, so a logout or an FCM
 * "unregistered" answer leaves a trail.
 */
@Schema({ timestamps: true, collection: "device_tokens" })
export class DeviceToken {
  @Prop({ required: true, type: SchemaTypes.ObjectId, ref: "User" })
  userId!: Types.ObjectId;

  @Prop({ required: true })
  token!: string;

  @Prop({ required: true, enum: DevicePlatform })
  platform!: DevicePlatform;

  /** The app's install id (the same one sent at login). */
  @Prop({ required: true })
  deviceId!: string;

  @Prop()
  appVersion?: string;

  @Prop({ required: true, default: true })
  isActive!: boolean;

  @Prop()
  deactivatedAt?: Date;

  @Prop({ enum: DeviceTokenDeactivation })
  deactivationReason?: DeviceTokenDeactivation;

  /** Last registration or successful push. */
  @Prop({ required: true })
  lastUsedAt!: Date;

  createdAt!: Date;
  updatedAt!: Date;
}

export type DeviceTokenDocument = HydratedDocument<DeviceToken>;
export const DeviceTokenSchema = SchemaFactory.createForClass(DeviceToken);

DeviceTokenSchema.index({ token: 1 }, { unique: true });
DeviceTokenSchema.index({ userId: 1, isActive: 1, lastUsedAt: -1 });
DeviceTokenSchema.index({ userId: 1, deviceId: 1 });
