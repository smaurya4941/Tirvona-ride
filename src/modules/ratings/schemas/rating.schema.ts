import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, Types } from "mongoose";
import type { HydratedDocument } from "mongoose";

/**
 * V1: the customer rates the driver, once per ride. Every field is derived
 * server-side from the ride except the stars and the comment — the app
 * never says which driver is being rated. Immutable once written.
 */
@Schema({ timestamps: true, collection: "ratings" })
export class Rating {
  @Prop({ required: true, type: SchemaTypes.ObjectId, ref: "Ride", immutable: true })
  rideId!: Types.ObjectId;

  @Prop({ required: true, type: SchemaTypes.ObjectId, ref: "User", immutable: true })
  customerId!: Types.ObjectId;

  @Prop({ required: true, type: SchemaTypes.ObjectId, ref: "DriverProfile", immutable: true })
  driverId!: Types.ObjectId;

  @Prop({ required: true, type: SchemaTypes.ObjectId, ref: "User", immutable: true })
  driverUserId!: Types.ObjectId;

  @Prop({
    required: true,
    min: 1,
    max: 5,
    immutable: true,
    validate: { validator: Number.isInteger, message: "rating must be a whole number" },
  })
  rating!: number;

  @Prop({ trim: true, maxlength: 500, immutable: true })
  comment?: string;

  createdAt!: Date;
  updatedAt!: Date;
}

export type RatingDocument = HydratedDocument<Rating>;
export const RatingSchema = SchemaFactory.createForClass(Rating);

// One rating per ride — the database is the last line against double submits.
RatingSchema.index({ rideId: 1 }, { unique: true });
RatingSchema.index({ rideId: 1, customerId: 1 }, { unique: true });
RatingSchema.index({ driverId: 1, createdAt: -1 });
RatingSchema.index({ customerId: 1, createdAt: -1 });
