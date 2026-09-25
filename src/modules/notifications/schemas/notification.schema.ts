import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, Types } from "mongoose";
import type { HydratedDocument } from "mongoose";
import { UserRole } from "../../../common/types/user-role.enum";
import { NotificationType, PushStatus } from "../notification-types";

/** Kept for ~6 months; the ride, payment and SOS records are the history. */
export const NOTIFICATION_RETENTION_SECONDS = 180 * 24 * 60 * 60;

@Schema({ _id: false })
export class NotificationPush {
  @Prop({ required: true, enum: PushStatus, default: PushStatus.PENDING })
  status!: PushStatus;

  @Prop({ default: 0 })
  sentCount!: number;

  @Prop({ default: 0 })
  failedCount!: number;

  @Prop()
  attemptedAt?: Date;

  @Prop()
  error?: string;
}
const NotificationPushSchema = SchemaFactory.createForClass(NotificationPush);

@Schema({ timestamps: true, collection: "notifications" })
export class Notification {
  @Prop({ required: true, type: SchemaTypes.ObjectId, ref: "User" })
  userId!: Types.ObjectId;

  @Prop({ required: true, enum: UserRole })
  recipientRole!: UserRole;

  @Prop({ required: true, enum: NotificationType })
  type!: NotificationType;

  @Prop({ required: true, trim: true, maxlength: 120 })
  title!: string;

  @Prop({ required: true, trim: true, maxlength: 500 })
  message!: string;

  @Prop({ type: SchemaTypes.ObjectId, ref: "Ride" })
  rideId?: Types.ObjectId;

  /** The SOS incident, complaint, payment… this is about. */
  @Prop()
  referenceId?: string;

  /** Flat string map: also the FCM `data` payload the app routes taps with. */
  @Prop({ type: SchemaTypes.Mixed, default: {} })
  data!: Record<string, string>;

  @Prop({ required: true, default: false })
  isRead!: boolean;

  @Prop()
  readAt?: Date;

  /**
   * Makes producing a notification idempotent: a replayed event (retry,
   * second instance, reconciler) hits the unique index instead of notifying
   * the user twice.
   */
  @Prop()
  dedupeKey?: string;

  @Prop({ type: NotificationPushSchema, default: () => ({}) })
  push!: NotificationPush;

  createdAt!: Date;
  updatedAt!: Date;
}

export type NotificationDocument = HydratedDocument<Notification>;
export const NotificationSchema = SchemaFactory.createForClass(Notification);

// The notification centre: newest first per user, and the unread badge.
NotificationSchema.index({ userId: 1, createdAt: -1 });
NotificationSchema.index({ userId: 1, isRead: 1, createdAt: -1 });
NotificationSchema.index(
  { dedupeKey: 1 },
  { unique: true, partialFilterExpression: { dedupeKey: { $type: "string" } }, name: "uniq_notification_dedupe" },
);
NotificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: NOTIFICATION_RETENTION_SECONDS });
