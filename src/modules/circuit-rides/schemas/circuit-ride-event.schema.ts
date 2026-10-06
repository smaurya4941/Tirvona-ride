import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, Types } from "mongoose";
import type { HydratedDocument } from "mongoose";
import { RideActorType } from "../../rides/ride-state-machine";

/**
 * The audit trail of what happened inside a circuit, below the ride's own
 * status history: who did what to which stop, when, and what the state was
 * before and after. Append-only; disputes and the admin booking timeline read it.
 */
@Schema({
  timestamps: { createdAt: true, updatedAt: false },
  collection: "circuit_ride_events",
})
export class CircuitRideEvent {
  @Prop({
    required: true,
    type: SchemaTypes.ObjectId,
    ref: "Ride",
    index: true,
  })
  rideId!: Types.ObjectId;

  /** BOOKED, STOP_ARRIVED, STOP_WAITING, STOP_COMPLETED, STOP_SKIPPED, STOP_BLOCKED, EXCEPTION_RESOLVED, WARNING, COMPLETED, ENDED_EARLY, … */
  @Prop({ required: true })
  type!: string;

  @Prop({ required: true, enum: RideActorType })
  actorType!: RideActorType;

  @Prop({ type: SchemaTypes.ObjectId })
  actorId?: Types.ObjectId;

  @Prop()
  stopOrder?: number;

  @Prop()
  fromState?: string;

  @Prop()
  toState?: string;

  @Prop({ trim: true })
  note?: string;

  @Prop({ type: SchemaTypes.Mixed })
  data?: Record<string, unknown>;
}

export type CircuitRideEventDocument = HydratedDocument<CircuitRideEvent>;
export const CircuitRideEventSchema =
  SchemaFactory.createForClass(CircuitRideEvent);
CircuitRideEventSchema.index({ rideId: 1, createdAt: 1, _id: 1 });
