import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, Types } from "mongoose";
import type { HydratedDocument } from "mongoose";
import { RIDE_TYPE_CODE_PATTERN } from "../../ride-types/schemas/ride-type.schema";
import { TIME_OF_DAY_PATTERN } from "../peak-pricing";

/**
 * A daily peak-hour window that raises the per-km rate by `hikePercent` for
 * the ride types it applies to (docs/pricing/peak-pricing.md). Slots are
 * configuration only: a ride copies what applied to it onto its own fare
 * snapshot, so editing or deleting a slot never changes a booked ride.
 *
 * Times are "HH:mm" in the business time zone (APP_TIME_ZONE). Start is
 * inclusive, end exclusive; start > end means the slot crosses midnight.
 */
@Schema({ timestamps: true, collection: "peak_pricing_slots" })
export class PeakPricingSlot {
  @Prop({ required: true, trim: true, minlength: 2, maxlength: 60 })
  name!: string;

  /** Lower-cased name, for the case-insensitive uniqueness check. */
  @Prop({ required: true })
  nameKey!: string;

  @Prop({ required: true, match: TIME_OF_DAY_PATTERN })
  startTime!: string;

  @Prop({ required: true, match: TIME_OF_DAY_PATTERN })
  endTime!: string;

  /** Increase on the per-km rate, in percent (50 = ×1.5). Two decimals at most. */
  @Prop({ required: true, min: 0.01, max: 300 })
  hikePercent!: number;

  /** True: every ride type (including ones created later). Otherwise `rideTypes`. */
  @Prop({ required: true, default: true })
  appliesToAll!: boolean;

  @Prop({
    type: [{ type: String, match: RIDE_TYPE_CODE_PATTERN }],
    default: [],
  })
  rideTypes!: string[];

  /** Disabled slots are kept (audit, re-enable) but never price a trip. */
  @Prop({ required: true, default: true })
  isActive!: boolean;

  /** Bumped on every edit; recorded in the audit log. */
  @Prop({ required: true, default: 1 })
  version!: number;

  @Prop({ type: SchemaTypes.ObjectId, ref: "User" })
  createdBy?: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: "User" })
  updatedBy?: Types.ObjectId;

  createdAt!: Date;
  updatedAt!: Date;
}

export type PeakPricingSlotDocument = HydratedDocument<PeakPricingSlot>;
export const PeakPricingSlotSchema =
  SchemaFactory.createForClass(PeakPricingSlot);

PeakPricingSlotSchema.index({ nameKey: 1 }, { unique: true });
PeakPricingSlotSchema.index({ isActive: 1 });
