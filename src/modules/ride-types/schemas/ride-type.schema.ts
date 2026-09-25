import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import type { HydratedDocument } from "mongoose";
import { VehicleType } from "../../vehicles/schemas/vehicle.schema";

/**
 * The products a customer can book. Deliberately separate from VehicleType:
 * today each ride type maps 1:1 onto a vehicle type, but products such as
 * "Cab XL" or "E-Rickshaw" can later map onto the same or new vehicles.
 */
export enum RideTypeCode {
  BIKE = "BIKE",
  AUTO = "AUTO",
  CAB = "CAB",
}

@Schema({ timestamps: true, collection: "ride_types" })
export class RideType {
  @Prop({ required: true, enum: RideTypeCode })
  code!: RideTypeCode;

  @Prop({ required: true, trim: true })
  displayName!: string;

  @Prop({ trim: true })
  description?: string;

  /** Stable icon key the mobile apps map to a bundled asset/icon. */
  @Prop({ required: true, trim: true })
  icon!: string;

  /** Which drivers can serve this ride type. */
  @Prop({ required: true, enum: VehicleType })
  vehicleType!: VehicleType;

  @Prop({ required: true, min: 1, max: 8 })
  seatCapacity!: number;

  @Prop({ required: true, default: 0 })
  sortOrder!: number;

  @Prop({ required: true, default: true })
  isActive!: boolean;
}

export type RideTypeDocument = HydratedDocument<RideType>;
export const RideTypeSchema = SchemaFactory.createForClass(RideType);

RideTypeSchema.index({ code: 1 }, { unique: true });
RideTypeSchema.index({ isActive: 1, sortOrder: 1 });
