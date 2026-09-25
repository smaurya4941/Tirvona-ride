import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, Types } from "mongoose";
import type { HydratedDocument } from "mongoose";
import { RideTypeCode } from "../../ride-types/schemas/ride-type.schema";
import { VehicleType } from "../../vehicles/schemas/vehicle.schema";
import { RidePaymentStatus } from "../ride-payment-status";
import { RideActorType, RideStatus } from "../ride-state-machine";

@Schema({ _id: false })
export class RideLocation {
  @Prop({ required: true, trim: true })
  address!: string;

  @Prop({ required: true, min: -90, max: 90 })
  latitude!: number;

  @Prop({ required: true, min: -180, max: 180 })
  longitude!: number;
}
const RideLocationSchema = SchemaFactory.createForClass(RideLocation);

/**
 * The tariff and breakdown at booking time. Snapshotted so a later admin
 * price change never alters a ride that is already booked or completed.
 */
@Schema({ _id: false })
export class RideFare {
  @Prop({ required: true })
  currency!: string;

  @Prop({ required: true })
  baseFare!: number;

  @Prop({ required: true })
  perKmRate!: number;

  @Prop({ required: true })
  perMinuteRate!: number;

  @Prop({ required: true })
  minimumFare!: number;

  @Prop({ required: true })
  distanceCharge!: number;

  @Prop({ required: true })
  timeCharge!: number;

  @Prop({ required: true })
  subtotal!: number;

  @Prop({ required: true })
  minimumFareApplied!: boolean;

  @Prop({ required: true })
  estimatedFare!: number;

  /** Set on completion. Phase 2: booked distance/time; Phase 3+: actual trip. */
  @Prop()
  finalFare?: number;

  @Prop({ required: true })
  pricingVersion!: number;
}
const RideFareSchema = SchemaFactory.createForClass(RideFare);

/** What the customer was told they'd be picked up in, frozen at assignment. */
@Schema({ _id: false })
export class RideVehicle {
  @Prop({ type: SchemaTypes.ObjectId, ref: "Vehicle" })
  vehicleId?: Types.ObjectId;

  @Prop({ required: true, enum: VehicleType })
  vehicleType!: VehicleType;

  @Prop({ required: true })
  registrationNumber!: string;

  @Prop()
  make?: string;

  @Prop()
  model?: string;

  @Prop()
  color?: string;
}
const RideVehicleSchema = SchemaFactory.createForClass(RideVehicle);

@Schema({ _id: false })
export class RideCancellation {
  @Prop({ required: true, enum: RideActorType })
  cancelledBy!: RideActorType;

  @Prop({ type: SchemaTypes.ObjectId, ref: "User" })
  cancelledByUserId?: Types.ObjectId;

  @Prop({ trim: true })
  reason?: string;
}
const RideCancellationSchema = SchemaFactory.createForClass(RideCancellation);

/**
 * Denormalised from the successful payment so ride reads (customer receipt
 * link, driver "payment received", admin lists) need no join. The payments
 * collection stays the source of record.
 */
@Schema({ _id: false })
export class RidePaymentSummary {
  @Prop({ required: true, type: SchemaTypes.ObjectId, ref: "Payment" })
  paymentId!: Types.ObjectId;

  /** Razorpay payment id (pay_…), once one is known. */
  @Prop()
  gatewayPaymentId?: string;

  /** UPI | CARD | NETBANKING | WALLET | … as reported by Razorpay. */
  @Prop()
  method?: string;

  /** Amount collected, rupees. */
  @Prop()
  amount?: number;

  @Prop()
  paidAt?: Date;

  @Prop()
  failureReason?: string;
}
const RidePaymentSummarySchema = SchemaFactory.createForClass(RidePaymentSummary);

@Schema({ timestamps: true, collection: "rides" })
export class Ride {
  /** Short human-friendly reference for support calls ("TR7K2M9QXA"). */
  @Prop({ required: true })
  rideCode!: string;

  @Prop({ required: true, type: SchemaTypes.ObjectId, ref: "User" })
  customerId!: Types.ObjectId;

  @Prop({ required: true, enum: RideTypeCode })
  rideType!: RideTypeCode;

  /** Resolved from the ride type at booking; what matching filters on. */
  @Prop({ required: true, enum: VehicleType })
  vehicleType!: VehicleType;

  @Prop({ required: true, type: RideLocationSchema })
  pickup!: RideLocation;

  @Prop({ required: true, type: RideLocationSchema })
  destination!: RideLocation;

  @Prop({ required: true, min: 0 })
  distanceMeters!: number;

  @Prop({ required: true, min: 0 })
  durationSeconds!: number;

  @Prop({ required: true })
  routeProvider!: string;

  @Prop({ required: true, type: RideFareSchema })
  fare!: RideFare;

  @Prop({ required: true, enum: RideStatus, default: RideStatus.SEARCHING })
  status!: RideStatus;

  /**
   * Denormalised `status ∈ ACTIVE_RIDE_STATUSES`, maintained by every
   * transition. Exists so partial unique indexes can enforce "one active ride
   * per customer / per driver" at the database level.
   */
  @Prop({ required: true, default: true })
  isActive!: boolean;

  /**
   * Bumped on every transition (and OTP rotation). Realtime snapshots and
   * REST reads both carry it, so a client can drop an older snapshot that
   * arrives after a newer one instead of flickering back.
   */
  @Prop({ required: true, default: 0 })
  stateVersion!: number;

  // ── Assignment ────────────────────────────────────────────────────────
  @Prop({ type: SchemaTypes.ObjectId, ref: "DriverProfile" })
  driverId?: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: "User" })
  driverUserId?: Types.ObjectId;

  @Prop({ type: RideVehicleSchema })
  vehicle?: RideVehicle;

  /** Straight-line driver → pickup distance when the driver was matched. */
  @Prop()
  driverDistanceMeters?: number;

  /** An assigned driver must accept before this, or the ride is re-matched. */
  @Prop()
  assignmentExpiresAt?: Date;

  /** Searching past this becomes NO_DRIVER_AVAILABLE. */
  @Prop({ required: true })
  searchExpiresAt!: Date;

  /** Drivers who rejected or ignored this ride; never re-offered it. */
  @Prop({ type: [SchemaTypes.ObjectId], default: [] })
  rejectedDriverIds!: Types.ObjectId[];

  @Prop({ required: true, default: 0 })
  dispatchCount!: number;

  // ── Start-of-trip OTP ─────────────────────────────────────────────────
  // Stored in clear (select: false) because the customer app must display
  // it; it is scoped to one ride, short-lived, attempt-limited, and removed
  // the moment it is verified.
  @Prop({ select: false })
  otpCode?: string;

  @Prop()
  otpExpiresAt?: Date;

  @Prop({ default: 0 })
  otpAttempts!: number;

  @Prop()
  otpVerifiedAt?: Date;

  @Prop({ type: RideCancellationSchema })
  cancellation?: RideCancellation;

  // ── Lifecycle timestamps ──────────────────────────────────────────────
  @Prop({ required: true })
  requestedAt!: Date;

  @Prop()
  assignedAt?: Date;

  @Prop()
  acceptedAt?: Date;

  @Prop()
  arrivedAt?: Date;

  @Prop()
  startedAt?: Date;

  @Prop()
  completedAt?: Date;

  @Prop()
  cancelledAt?: Date;

  @Prop()
  expiredAt?: Date;

  // ── Approach (Phase 3) ────────────────────────────────────────────────
  /**
   * First time the accepted driver came within DRIVER_ARRIVING_RADIUS_METERS
   * of the pickup. Set once with a conditional update, so `ride.driver_arriving`
   * is emitted exactly once even with several fixes/instances racing.
   */
  @Prop()
  arrivingNotifiedAt?: Date;

  // ── Payment (Phase 4) ─────────────────────────────────────────────────
  /**
   * Money state, independent of `status`. Written only by
   * RidePaymentStateService (and PENDING by the completion transition).
   */
  @Prop({ required: true, enum: RidePaymentStatus, default: RidePaymentStatus.NOT_REQUIRED })
  paymentStatus!: RidePaymentStatus;

  @Prop({ type: RidePaymentSummarySchema })
  payment?: RidePaymentSummary;
}

export type RideDocument = HydratedDocument<Ride>;
export const RideSchema = SchemaFactory.createForClass(Ride);

RideSchema.index({ rideCode: 1 }, { unique: true });
RideSchema.index({ customerId: 1, requestedAt: -1 });
RideSchema.index({ driverId: 1, requestedAt: -1 });
RideSchema.index({ status: 1, requestedAt: -1 });
// Unpaid completed rides (ops follow-up, customer "pay now").
RideSchema.index({ paymentStatus: 1, completedAt: -1 });
// Sweeper scans.
RideSchema.index({ status: 1, assignmentExpiresAt: 1 });
RideSchema.index({ status: 1, searchExpiresAt: 1 });
// One active ride per customer, enforced by the database under concurrency.
RideSchema.index(
  { customerId: 1 },
  { unique: true, partialFilterExpression: { isActive: true }, name: "uniq_active_ride_per_customer" },
);
// One active ride per driver. `$exists` keeps unassigned SEARCHING rides out.
RideSchema.index(
  { driverId: 1 },
  {
    unique: true,
    partialFilterExpression: { isActive: true, driverId: { $exists: true } },
    name: "uniq_active_ride_per_driver",
  },
);
