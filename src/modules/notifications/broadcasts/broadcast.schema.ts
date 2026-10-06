import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, Types } from "mongoose";
import type { HydratedDocument } from "mongoose";

export enum BroadcastAudience {
  ALL_CUSTOMERS = "ALL_CUSTOMERS",
  ALL_DRIVERS = "ALL_DRIVERS",
  /** Drivers whose KYC is approved (can take rides). */
  APPROVED_DRIVERS = "APPROVED_DRIVERS",
  /** Every active customer and driver account (never admins). */
  ALL_USERS = "ALL_USERS",
}

/** Where tapping the notification takes the user in the app. */
export enum BroadcastDeepLink {
  NONE = "NONE",
  HOME = "HOME",
  RIDES = "RIDES",
  OFFERS = "OFFERS",
  NOTIFICATIONS = "NOTIFICATIONS",
  SUPPORT = "SUPPORT",
}

export enum BroadcastStatus {
  DRAFT = "DRAFT",
  SCHEDULED = "SCHEDULED",
  SENDING = "SENDING",
  SENT = "SENT",
  CANCELLED = "CANCELLED",
  FAILED = "FAILED",
}

/**
 * An admin-initiated announcement. Kept apart from system notifications
 * (which are generated from ride/payment/safety events): a broadcast fans out
 * into one ANNOUNCEMENT notification per recipient, deduplicated per user,
 * and is sent in id-ordered batches so an interrupted send resumes where it
 * stopped instead of starting over.
 */
@Schema({ timestamps: true, collection: "broadcasts" })
export class Broadcast {
  @Prop({ required: true, trim: true, maxlength: 120 })
  title!: string;

  @Prop({ required: true, trim: true, maxlength: 500 })
  message!: string;

  @Prop({ required: true, enum: BroadcastAudience })
  audience!: BroadcastAudience;

  @Prop({
    required: true,
    enum: BroadcastDeepLink,
    default: BroadcastDeepLink.NONE,
  })
  deepLink!: BroadcastDeepLink;

  @Prop({
    required: true,
    enum: BroadcastStatus,
    default: BroadcastStatus.DRAFT,
  })
  status!: BroadcastStatus;

  @Prop()
  scheduledAt?: Date;

  @Prop()
  startedAt?: Date;

  @Prop()
  sentAt?: Date;

  /** Recipients notified so far (final count once SENT). */
  @Prop({ required: true, default: 0 })
  processedCount!: number;

  /** Resume cursor: the last user id notified. */
  @Prop({ type: SchemaTypes.ObjectId })
  lastUserId?: Types.ObjectId;

  /** A sender holds the broadcast until this time; after it another may resume. */
  @Prop()
  leaseUntil?: Date;

  @Prop()
  error?: string;

  @Prop({ required: true, type: SchemaTypes.ObjectId, ref: "User" })
  createdBy!: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: "User" })
  updatedBy?: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: "User" })
  sentBy?: Types.ObjectId;
}

export type BroadcastDocument = HydratedDocument<Broadcast>;
export const BroadcastSchema = SchemaFactory.createForClass(Broadcast);

BroadcastSchema.index({ status: 1, scheduledAt: 1 });
BroadcastSchema.index({ status: 1, leaseUntil: 1 });
BroadcastSchema.index({ createdAt: -1 });
