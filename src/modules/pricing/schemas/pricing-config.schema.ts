import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, Types } from "mongoose";
import type { HydratedDocument } from "mongoose";
import { RideTypeCode } from "../../ride-types/schemas/ride-type.schema";

/**
 * One active tariff per ride type. Amounts are rupees with at most two
 * decimals (validated at the API edge); FareCalculator converts to paise.
 * `version` increments on every admin edit and is snapshotted onto each ride,
 * so a ride's fare can always be traced to the tariff that produced it.
 */
@Schema({ timestamps: true, collection: "pricing_configs" })
export class PricingConfig {
  @Prop({ required: true, enum: RideTypeCode })
  rideType!: RideTypeCode;

  @Prop({ required: true, default: "INR" })
  currency!: string;

  @Prop({ required: true, min: 0 })
  baseFare!: number;

  @Prop({ required: true, min: 0 })
  perKmRate!: number;

  @Prop({ required: true, min: 0 })
  perMinuteRate!: number;

  @Prop({ required: true, min: 0 })
  minimumFare!: number;

  @Prop({ required: true, default: 1 })
  version!: number;

  @Prop({ type: SchemaTypes.ObjectId, ref: "User" })
  updatedBy?: Types.ObjectId;
}

export type PricingConfigDocument = HydratedDocument<PricingConfig>;
export const PricingConfigSchema = SchemaFactory.createForClass(PricingConfig);

PricingConfigSchema.index({ rideType: 1 }, { unique: true });
