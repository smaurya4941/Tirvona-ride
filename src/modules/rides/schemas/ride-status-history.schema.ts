import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, Types } from "mongoose";
import type { HydratedDocument } from "mongoose";
import { RideActorType, RideStatus } from "../ride-state-machine";

/**
 * Append-only audit trail: one row per status change, written by
 * RideTransitionService. Used by admin/support, debugging and (later)
 * dispute handling and analytics.
 */
@Schema({
  timestamps: { createdAt: true, updatedAt: false },
  collection: "ride_status_history",
})
export class RideStatusHistory {
  @Prop({ required: true, type: SchemaTypes.ObjectId, ref: "Ride" })
  rideId!: Types.ObjectId;

  /** Absent for the creation row. */
  @Prop({ enum: RideStatus })
  fromStatus?: RideStatus;

  @Prop({ required: true, enum: RideStatus })
  toStatus!: RideStatus;

  @Prop({ required: true, enum: RideActorType })
  actorType!: RideActorType;

  /** User id of the actor; absent for SYSTEM. */
  @Prop({ type: SchemaTypes.ObjectId, ref: "User" })
  actorId?: Types.ObjectId;

  @Prop({ trim: true })
  reason?: string;

  @Prop({ type: SchemaTypes.Mixed })
  metadata?: Record<string, unknown>;
}

export type RideStatusHistoryDocument = HydratedDocument<RideStatusHistory>;
export const RideStatusHistorySchema = SchemaFactory.createForClass(RideStatusHistory);

RideStatusHistorySchema.index({ rideId: 1, createdAt: 1 });
