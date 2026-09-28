import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import type { HydratedDocument } from "mongoose";
import { VehicleType } from "../../vehicles/schemas/vehicle.schema";

/**
 * The V1 products seeded on first boot (locked blueprint: BIKE, AUTO,
 * E_RICKSHAW, CAB). Since Phase 7 a ride type's code is data, not an enum:
 * admins can create further products (e.g. "CAB_XL" served by CAB drivers)
 * without a deploy. These constants remain for seeds, tests and defaults.
 */
export enum RideTypeCode {
  BIKE = "BIKE",
  AUTO = "AUTO",
  E_RICKSHAW = "E_RICKSHAW",
  CAB = "CAB",
}

/** Upper-case letters, digits and underscores, starting with a letter. */
export const RIDE_TYPE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,23}$/;

/**
 * Products are deliberately separate from VehicleType: each ride type maps
 * onto exactly one vehicle type (what matching filters on), and several
 * products may share one (Cab and Cab XL).
 *
 * Never deleted: historical rides reference the code, so a retired product
 * is switched off (isActive=false) and stays readable.
 */
@Schema({ timestamps: true, collection: "ride_types" })
export class RideType {
  @Prop({ required: true, match: RIDE_TYPE_CODE_PATTERN, immutable: true })
  code!: string;

  @Prop({ required: true, trim: true })
  displayName!: string;

  @Prop({ trim: true })
  description?: string;

  /** Stable icon key the mobile apps map to a bundled icon (bike, auto, e_rickshaw, cab). */
  @Prop({ required: true, trim: true })
  icon!: string;

  /** Which drivers can serve this ride type. */
  @Prop({ required: true, enum: VehicleType })
  vehicleType!: VehicleType;

  @Prop({ required: true, min: 1, max: 8 })
  seatCapacity!: number;

  @Prop({ required: true, default: 0 })
  sortOrder!: number;

  /** ACTIVE = customers can book it; INACTIVE = hidden from booking, history kept. */
  @Prop({ required: true, default: true })
  isActive!: boolean;
}

export type RideTypeDocument = HydratedDocument<RideType>;
export const RideTypeSchema = SchemaFactory.createForClass(RideType);

RideTypeSchema.index({ code: 1 }, { unique: true });
RideTypeSchema.index({ isActive: 1, sortOrder: 1 });
