import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, Types } from "mongoose";
import type { HydratedDocument } from "mongoose";

/** Expired links are purged a week after they stop working. */
export const SHARE_TOKEN_PURGE_AFTER_SECONDS = 7 * 24 * 60 * 60;

/**
 * A public, read-only link to one ride's status. Only a SHA-256 of the
 * token is stored: the link itself exists only in the customer's share
 * sheet, so a database dump cannot be used to track anyone.
 */
@Schema({ timestamps: true, collection: "ride_share_tokens" })
export class RideShareToken {
  @Prop({ required: true, type: SchemaTypes.ObjectId, ref: "Ride" })
  rideId!: Types.ObjectId;

  @Prop({ required: true, type: SchemaTypes.ObjectId, ref: "User" })
  customerId!: Types.ObjectId;

  @Prop({ required: true })
  tokenHash!: string;

  /**
   * Hard expiry. Set to creation + SHARE_RIDE_MAX_HOURS, then pulled in to
   * ride end + SHARE_RIDE_GRACE_MINUTES when the ride finishes.
   */
  @Prop({ required: true })
  expiresAt!: Date;

  @Prop({ required: true, default: true })
  isActive!: boolean;

  @Prop()
  revokedAt?: Date;

  @Prop({ default: 0 })
  viewCount!: number;

  @Prop()
  lastViewedAt?: Date;

  createdAt!: Date;
  updatedAt!: Date;
}

export type RideShareTokenDocument = HydratedDocument<RideShareToken>;
export const RideShareTokenSchema = SchemaFactory.createForClass(RideShareToken);

RideShareTokenSchema.index({ tokenHash: 1 }, { unique: true });
RideShareTokenSchema.index({ rideId: 1, isActive: 1 });
RideShareTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: SHARE_TOKEN_PURGE_AFTER_SECONDS });
