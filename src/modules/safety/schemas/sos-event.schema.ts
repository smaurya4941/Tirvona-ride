import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, Types } from "mongoose";
import type { HydratedDocument } from "mongoose";
import { UserRole } from "../../../common/types/user-role.enum";
import { RideStatus } from "../../rides/ride-state-machine";
import { SosLocationSource, SosStatus } from "../sos-lifecycle";

@Schema({ _id: false })
export class SosLocation {
  @Prop({ required: true, min: -90, max: 90 })
  latitude!: number;

  @Prop({ required: true, min: -180, max: 180 })
  longitude!: number;

  @Prop()
  accuracyMeters?: number;

  @Prop({ trim: true })
  address?: string;

  @Prop({ required: true, enum: SosLocationSource })
  source!: SosLocationSource;

  @Prop({ required: true })
  capturedAt!: Date;
}
const SosLocationSchema = SchemaFactory.createForClass(SosLocation);

@Schema({ _id: false })
export class SosContactSnapshot {
  @Prop({ required: true })
  name!: string;

  @Prop({ required: true })
  phone!: string;

  @Prop()
  relationship?: string;

  @Prop({ default: false })
  isPrimary!: boolean;
}
const SosContactSnapshotSchema =
  SchemaFactory.createForClass(SosContactSnapshot);

/** One WhatsApp message to an emergency contact: what was sent and whether Meta accepted it. */
@Schema({ _id: false })
export class SosContactAlert {
  @Prop({ required: true })
  phone!: string;

  @Prop({ required: true })
  name!: string;

  /** ALERT: the first message. UPDATE: a newer position. */
  @Prop({ required: true, enum: ["ALERT", "UPDATE"] })
  kind!: "ALERT" | "UPDATE";

  @Prop({ required: true, enum: ["SENT", "FAILED"] })
  status!: "SENT" | "FAILED";

  /** WhatsApp message id (wamid.…) when accepted. */
  @Prop()
  messageId?: string;

  /** Why it failed, reduced to what an operator can act on (never Meta's raw error). */
  @Prop()
  failure?: string;

  @Prop({ required: true, default: 1 })
  attempts!: number;

  @Prop({ required: true })
  at!: Date;
}
const SosContactAlertSchema = SchemaFactory.createForClass(SosContactAlert);

@Schema({ _id: false })
export class SosTimelineEntry {
  @Prop({ required: true, enum: SosStatus })
  status!: SosStatus;

  @Prop({ required: true })
  at!: Date;

  @Prop({ type: SchemaTypes.ObjectId, ref: "User" })
  byUserId?: Types.ObjectId;

  @Prop({ required: true, enum: UserRole })
  byRole!: UserRole;

  @Prop({ trim: true, maxlength: 1000 })
  note?: string;
}
const SosTimelineEntrySchema = SchemaFactory.createForClass(SosTimelineEntry);

/**
 * One SOS incident. Never deleted: resolved incidents are the safety record.
 * Ride facts (code, people, vehicle, route) are snapshotted at trigger time
 * so the safety team sees the incident as it was, in one read.
 */
@Schema({ timestamps: true, collection: "sos_events" })
export class SosEvent {
  /** Short reference read out on calls ("SOS-7K2M9Q"). */
  @Prop({ required: true })
  sosCode!: string;

  @Prop({ required: true, type: SchemaTypes.ObjectId, ref: "Ride" })
  rideId!: Types.ObjectId;

  @Prop({ required: true })
  rideCode!: string;

  /** Ride status when the alert was raised. */
  @Prop({ required: true, enum: RideStatus })
  rideStatus!: RideStatus;

  /** Who pressed SOS. */
  @Prop({ required: true, type: SchemaTypes.ObjectId, ref: "User" })
  userId!: Types.ObjectId;

  @Prop({ required: true, enum: [UserRole.CUSTOMER, UserRole.DRIVER] })
  userRole!: UserRole;

  @Prop({ required: true, type: SchemaTypes.ObjectId, ref: "User" })
  customerId!: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: "DriverProfile" })
  driverId?: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: "User" })
  driverUserId?: Types.ObjectId;

  @Prop({ required: true, enum: SosStatus, default: SosStatus.TRIGGERED })
  status!: SosStatus;

  /** Denormalised `status ∈ OPEN_SOS_STATUSES` for the one-open-alert index. */
  @Prop({ required: true, default: true })
  isOpen!: boolean;

  @Prop({ required: true, type: SosLocationSchema })
  location!: SosLocation;

  /** Later fixes from the same user while the incident is open. */
  @Prop({ type: [SosLocationSchema], default: [] })
  locationUpdates!: SosLocation[];

  @Prop({ trim: true, maxlength: 500 })
  message?: string;

  @Prop({ type: [SosContactSnapshotSchema], default: [] })
  emergencyContacts!: SosContactSnapshot[];

  /**
   * Honest record of contact outreach over WhatsApp: SENT when at least one
   * contact's alert was accepted by WhatsApp, FAILED when every attempt
   * failed, NOT_SENT when there was nobody to message (or messaging is off).
   * Per-contact detail is in `contactAlerts`.
   */
  @Prop({
    required: true,
    default: "NOT_SENT",
    enum: ["NOT_SENT", "SENT", "FAILED"],
  })
  contactsNotification!: "NOT_SENT" | "SENT" | "FAILED";

  /** Every WhatsApp message sent to the contacts for this incident (newest last, capped). */
  @Prop({ type: [SosContactAlertSchema], default: [] })
  contactAlerts!: SosContactAlert[];

  /**
   * The live-tracking link token shared with the contacts. The link is a
   * capability URL, so it is never returned by an API: only this service
   * reads it, to put it in follow-up messages.
   */
  @Prop({ select: false })
  trackingToken?: string;

  @Prop({ required: true })
  triggeredAt!: Date;

  @Prop()
  acknowledgedAt?: Date;

  @Prop()
  inProgressAt?: Date;

  @Prop()
  resolvedAt?: Date;

  @Prop()
  cancelledAt?: Date;

  /** Admin currently owning the incident (last one to act on it). */
  @Prop({ type: SchemaTypes.ObjectId, ref: "User" })
  adminId?: Types.ObjectId;

  @Prop({ trim: true, maxlength: 2000 })
  resolutionNote?: string;

  @Prop({ type: [SosTimelineEntrySchema], default: [] })
  timeline!: SosTimelineEntry[];

  createdAt!: Date;
  updatedAt!: Date;
}

export type SosEventDocument = HydratedDocument<SosEvent>;
export const SosEventSchema = SchemaFactory.createForClass(SosEvent);

SosEventSchema.index({ sosCode: 1 }, { unique: true });
SosEventSchema.index({ rideId: 1, createdAt: -1 });
SosEventSchema.index({ userId: 1, createdAt: -1 });
SosEventSchema.index({ status: 1, createdAt: -1 });
SosEventSchema.index({ createdAt: -1 });
// Repeated presses while an alert is open update it instead of opening another.
SosEventSchema.index(
  { rideId: 1, userId: 1 },
  {
    unique: true,
    partialFilterExpression: { isOpen: true },
    name: "uniq_open_sos_per_ride_user",
  },
);
