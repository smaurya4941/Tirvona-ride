import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, Types } from "mongoose";
import type { HydratedDocument } from "mongoose";

export enum VehicleType {
  BIKE = "BIKE",
  AUTO = "AUTO",
  CAB = "CAB",
}

@Schema({ timestamps: true, collection: "vehicles" })
export class Vehicle {
  @Prop({ required: true, type: SchemaTypes.ObjectId, ref: "DriverProfile" })
  driverId!: Types.ObjectId;

  @Prop({ required: true, enum: VehicleType })
  vehicleType!: VehicleType;

  @Prop({ required: true, uppercase: true, trim: true })
  registrationNumber!: string;

  @Prop()
  make?: string;

  // Named `vehicleModel`, not `model` — the latter collides with Mongoose's
  // built-in Document#model() method and breaks the generated types.
  @Prop()
  vehicleModel?: string;

  @Prop()
  color?: string;

  @Prop()
  manufactureYear?: number;

  @Prop()
  vehicleImage?: string;

  @Prop({ required: true, default: true })
  isActive!: boolean;
}

export type VehicleDocument = HydratedDocument<Vehicle>;
export const VehicleSchema = SchemaFactory.createForClass(Vehicle);

VehicleSchema.index({ registrationNumber: 1 }, { unique: true });
VehicleSchema.index({ driverId: 1, isActive: 1 });
