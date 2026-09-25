import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, Types } from "mongoose";
import type { HydratedDocument } from "mongoose";
import { GeoPoint, GeoPointSchema } from "../../../common/schemas/geo-point.schema";

export enum CheckpointKind {
  /** Where the driver was when they accepted. */
  ACCEPTED = "ACCEPTED",
  /** First fix inside DRIVER_ARRIVING_RADIUS_METERS of the pickup. */
  ARRIVING = "ARRIVING",
  ARRIVED = "ARRIVED",
  STARTED = "STARTED",
  /** Coarse trail sample, at most one per RIDE_CHECKPOINT_INTERVAL_SECONDS. */
  TRIP = "TRIP",
  COMPLETED = "COMPLETED",
  CANCELLED = "CANCELLED",
}

export enum CheckpointSource {
  /** A live GPS fix received over the socket within the freshness window. */
  LIVE = "LIVE",
  /** The driver's last persisted position (no recent live fix available). */
  LAST_KNOWN = "LAST_KNOWN",
}

/**
 * Ride-scoped location history: the handful of positions that matter for
 * support, disputes and (later) actual-distance fares. This is deliberately
 * NOT a GPS dump — live pings travel driver → socket → customer and are never
 * written here one by one.
 */
@Schema({
  timestamps: { createdAt: true, updatedAt: false },
  collection: "driver_location_checkpoints",
})
export class DriverLocationCheckpoint {
  @Prop({ required: true, type: SchemaTypes.ObjectId, ref: "Ride" })
  rideId!: Types.ObjectId;

  @Prop({ required: true, type: SchemaTypes.ObjectId, ref: "DriverProfile" })
  driverId!: Types.ObjectId;

  @Prop({ required: true, enum: CheckpointKind })
  kind!: CheckpointKind;

  @Prop({ required: true, type: GeoPointSchema })
  location!: GeoPoint;

  @Prop({ min: 0, max: 360 })
  heading?: number;

  /** Metres per second. */
  @Prop({ min: 0 })
  speed?: number;

  /** Horizontal accuracy radius in metres. */
  @Prop({ min: 0 })
  accuracy?: number;

  @Prop({ required: true, enum: CheckpointSource })
  source!: CheckpointSource;

  /** When the fix was taken (device clock, clamped to server time). */
  @Prop({ required: true })
  recordedAt!: Date;
}

export type DriverLocationCheckpointDocument = HydratedDocument<DriverLocationCheckpoint>;
export const DriverLocationCheckpointSchema = SchemaFactory.createForClass(DriverLocationCheckpoint);

DriverLocationCheckpointSchema.index({ rideId: 1, recordedAt: 1 });
DriverLocationCheckpointSchema.index({ driverId: 1, createdAt: -1 });
