import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, Types } from "mongoose";
import type { HydratedDocument } from "mongoose";
import { GeoPoint, GeoPointSchema } from "../../../common/schemas/geo-point.schema";
import { VehicleType } from "../../vehicles/schemas/vehicle.schema";

export enum DriverStatus {
  PENDING = "PENDING",
  UNDER_REVIEW = "UNDER_REVIEW",
  APPROVED = "APPROVED",
  REJECTED = "REJECTED",
  SUSPENDED = "SUSPENDED",
}

@Schema({ timestamps: true, collection: "driver_profiles" })
export class DriverProfile {
  @Prop({ required: true, type: SchemaTypes.ObjectId, ref: "User" })
  userId!: Types.ObjectId;

  @Prop({ required: true })
  driverCode!: string;

  @Prop({
    required: true,
    enum: DriverStatus,
    default: DriverStatus.PENDING,
  })
  driverStatus!: DriverStatus;

  @Prop()
  licenseNumber?: string;

  @Prop()
  licenseExpiry?: Date;

  @Prop()
  dateOfBirth?: Date;

  @Prop()
  address?: string;

  /** Average customer rating, 2 decimals. Maintained by RatingsService only. */
  @Prop({ required: true, default: 0 })
  ratingAverage!: number;

  /** Number of customer ratings behind ratingAverage (Phase 5). */
  @Prop({ required: true, default: 0 })
  ratingCount!: number;

  /** Sum of all star values, so the average updates atomically per rating. */
  @Prop({ required: true, default: 0 })
  ratingSum!: number;

  @Prop({ required: true, default: 0 })
  totalRides!: number;

  @Prop({ required: true, default: false })
  isOnline!: boolean;

  @Prop({ required: true, default: false })
  isAvailable!: boolean;

  @Prop()
  approvedAt?: Date;

  @Prop({ type: SchemaTypes.ObjectId, ref: "User" })
  approvedBy?: Types.ObjectId;

  @Prop()
  rejectionReason?: string;

  // ── Duty / matching state (Phase 2) ──────────────────────────────────
  // Written only by DriverAvailabilityService and the matching/ride
  // services, never from a client payload.

  /** Latest known position as GeoJSON — indexed 2dsphere for matching. */
  @Prop({ type: GeoPointSchema })
  currentLocation?: GeoPoint;

  @Prop()
  locationUpdatedAt?: Date;

  /**
   * Last time the driver app talked to us while online. Matching skips
   * drivers whose app went silent (killed, lost network) without going
   * offline, so a request is never offered to a phone nobody is watching.
   */
  @Prop()
  lastSeenAt?: Date;

  /** Vehicle the driver went online with; decides which ride types they serve. */
  @Prop({ type: SchemaTypes.ObjectId, ref: "Vehicle" })
  activeVehicleId?: Types.ObjectId;

  @Prop({ enum: VehicleType })
  activeVehicleType?: VehicleType;

  /**
   * The ride this driver is reserved for (assigned or in progress). Set
   * atomically together with `isAvailable: false`, so a driver can never be
   * matched to two rides at once.
   */
  @Prop({ type: SchemaTypes.ObjectId, ref: "Ride" })
  currentRideId?: Types.ObjectId;

  @Prop()
  wentOnlineAt?: Date;
}

export type DriverProfileDocument = HydratedDocument<DriverProfile>;
export const DriverProfileSchema = SchemaFactory.createForClass(DriverProfile);

DriverProfileSchema.index({ userId: 1 }, { unique: true });
DriverProfileSchema.index({ driverCode: 1 }, { unique: true });
DriverProfileSchema.index({ driverStatus: 1 });
// Matching: $geoNear over online+available drivers of one vehicle type.
DriverProfileSchema.index({
  currentLocation: "2dsphere",
  isOnline: 1,
  isAvailable: 1,
  activeVehicleType: 1,
});
