import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, Types } from "mongoose";
import type { HydratedDocument } from "mongoose";
import { RIDE_TYPE_CODE_PATTERN } from "../../ride-types/schemas/ride-type.schema";

/**
 * How long a trip may be, for one ride type. Exactly one row per ride type
 * (unique on the code), edited in place by admins: `version` counts the edits
 * and is copied, with the two limits, onto every ride at booking, so a ride
 * always remembers the policy it was accepted under.
 *
 * Minimum is in metres and maximum in kilometres on purpose — the units admins
 * think in — and the field names carry the unit.
 */
@Schema({ timestamps: true, collection: "ride_distance_configs" })
export class RideDistanceConfig {
  /** RideType.code; the join key every other module uses. */
  @Prop({ required: true, match: RIDE_TYPE_CODE_PATTERN, immutable: true })
  rideType!: string;

  @Prop({ type: SchemaTypes.ObjectId, ref: "RideType" })
  rideTypeId?: Types.ObjectId;

  @Prop({ required: true, min: 1 })
  minDistanceMeters!: number;

  @Prop({ required: true, min: 0.001 })
  maxDistanceKm!: number;

  /** 1 on creation, +1 per admin edit. */
  @Prop({ required: true, min: 1, default: 1 })
  version!: number;

  /** Absent on rows written by the first-boot migration. */
  @Prop({ type: SchemaTypes.ObjectId, ref: "User" })
  updatedBy?: Types.ObjectId;
}

export type RideDistanceConfigDocument = HydratedDocument<RideDistanceConfig>;
export const RideDistanceConfigSchema =
  SchemaFactory.createForClass(RideDistanceConfig);

RideDistanceConfigSchema.index({ rideType: 1 }, { unique: true });
