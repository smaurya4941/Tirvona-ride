import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, Types } from "mongoose";
import type { HydratedDocument } from "mongoose";
import { VehicleType } from "../../vehicles/schemas/vehicle.schema";
import { RidePaymentStatus } from "../ride-payment-status";
import { RideActorType, RideStatus } from "../ride-state-machine";
import { PromoDiscountType } from "../../promotions/promo-rules";
import { RideKind } from "../../circuit-rides/circuit-ride.types";
import {
  RideCircuit,
  RideCircuitSchema,
} from "../../circuit-rides/schemas/ride-circuit.schema";

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
 * The trip-distance limits this ride was accepted under, frozen at booking.
 * Later admin edits to the ride type's limits never touch it. Rides booked
 * before limits became admin-controlled have no snapshot.
 */
@Schema({ _id: false })
export class RideDistancePolicy {
  @Prop({ required: true })
  rideType!: string;

  @Prop({ required: true, min: 0 })
  minDistanceMeters!: number;

  @Prop({ required: true, min: 0 })
  maxDistanceMeters!: number;

  /** RideDistanceConfig._id and its version when the ride was booked. */
  @Prop({ required: true })
  configId!: string;

  @Prop({ required: true, min: 1 })
  configVersion!: number;
}
const RideDistancePolicySchema =
  SchemaFactory.createForClass(RideDistancePolicy);

/**
 * The bill as priced at completion, frozen: the trip measured, the tariff
 * applied (the booking snapshot, `pricingVersion`), each component, the
 * customer-protection cap and the discount. Payments and earnings read this,
 * never the current pricing configuration.
 */
@Schema({ _id: false })
export class RideFinalFare {
  @Prop({ required: true, min: 0 })
  distanceMeters!: number;

  @Prop({ required: true, min: 0 })
  durationSeconds!: number;

  /** ACTUAL (GPS trail) or BOOKED (the booked route: trail missing/unreliable, or booked mode). */
  @Prop({ required: true })
  distanceSource!: string;

  /** ACTUAL (start → complete) or BOOKED. */
  @Prop({ required: true })
  durationSource!: string;

  /** Trail distance even when not billed (support and disputes). */
  @Prop({ min: 0 })
  measuredDistanceMeters?: number;

  @Prop({ required: true })
  baseFare!: number;

  @Prop({ required: true })
  distanceCharge!: number;

  @Prop({ required: true })
  timeCharge!: number;

  @Prop({ required: true })
  subtotal!: number;

  @Prop({ required: true })
  minimumFareApplied!: boolean;

  /** The fare was limited to FINAL_FARE_MAX_ESTIMATE_MULTIPLIER × estimate. */
  @Prop({ required: true, default: false })
  capApplied!: boolean;

  @Prop()
  uncappedFare?: number;

  /** = fare.finalFare */
  @Prop({ required: true })
  total!: number;

  @Prop({ required: true, min: 0, default: 0 })
  discount!: number;

  /** What the customer owes (= fare.payableFare when a promo applies, else total). */
  @Prop({ required: true, min: 0 })
  payable!: number;

  @Prop({ required: true })
  pricingVersion!: number;

  /** actual | booked — the FINAL_FARE_MODE in force at completion. */
  @Prop({ required: true })
  mode!: string;

  @Prop({ required: true })
  computedAt!: Date;
}
const RideFinalFareSchema = SchemaFactory.createForClass(RideFinalFare);

/** The peak slot that raised this ride's per-km rate, copied at booking so later edits never touch the ride. */
@Schema({ _id: false })
export class RidePeakFare {
  @Prop({ required: true })
  slotId!: string;

  @Prop({ required: true })
  name!: string;

  @Prop({ required: true })
  hikePercent!: number;

  @Prop({ required: true })
  startTime!: string;

  @Prop({ required: true })
  endTime!: string;

  /** Extra distance charge caused by the peak, rupees, on the booked route. */
  @Prop({ required: true })
  surcharge!: number;
}
const RidePeakFareSchema = SchemaFactory.createForClass(RidePeakFare);

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

  /** The rate the ride is charged at: the base rate, or the peak-raised rate when `peak` is set. */
  @Prop({ required: true })
  perKmRate!: number;

  /** The permanent per-km rate. Absent on rides booked before peak pricing existed (= perKmRate). */
  @Prop()
  basePerKmRate?: number;

  /** Present when a peak slot was in force at booking; the ride keeps this rate through completion. */
  @Prop({ type: RidePeakFareSchema })
  peak?: RidePeakFare;

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

  /**
   * Promo discount (Phase 7), rupees: the estimate at booking, replaced by
   * the discount on the final fare at completion. Platform-funded.
   */
  @Prop({ min: 0 })
  discount?: number;

  /** What the customer pays: finalFare − discount (set on completion when a promo applies). */
  @Prop({ min: 0 })
  payableFare?: number;

  @Prop({ required: true })
  pricingVersion!: number;

  /** The final bill, frozen at completion (absent on rides completed before it existed). */
  @Prop({ type: RideFinalFareSchema })
  final?: RideFinalFare;
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

/** The promo applied at booking — its rules are frozen here (Phase 7). */
@Schema({ _id: false })
export class RidePromo {
  @Prop({ required: true, type: SchemaTypes.ObjectId, ref: "PromoCode" })
  promoId!: Types.ObjectId;

  @Prop({ required: true })
  code!: string;

  @Prop({ required: true })
  title!: string;

  @Prop({ required: true, enum: PromoDiscountType })
  discountType!: PromoDiscountType;

  @Prop({ required: true })
  discountValue!: number;

  @Prop()
  maxDiscount?: number;

  @Prop({ required: true, min: 0 })
  estimatedDiscount!: number;
}
const RidePromoSchema = SchemaFactory.createForClass(RidePromo);

@Schema({ _id: false })
export class RideCancellation {
  @Prop({ required: true, enum: RideActorType })
  cancelledBy!: RideActorType;

  @Prop({ type: SchemaTypes.ObjectId, ref: "User" })
  cancelledByUserId?: Types.ObjectId;

  /** Free text (legacy) or the chosen reason label. */
  @Prop({ trim: true })
  reason?: string;

  /** Controlled reason code (Phase 7). */
  @Prop()
  reasonCode?: string;

  @Prop({ trim: true })
  note?: string;

  /** Cancellation fee assessed, rupees (Phase 7). */
  @Prop({ min: 0 })
  feeAmount?: number;

  /** NOT_APPLICABLE | DUE | WAIVED | COLLECTED — mirrors the cancellations record. */
  @Prop()
  feeStatus?: string;
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

  /** Refunded to the customer so far, rupees (processed refunds only). */
  @Prop({ min: 0 })
  refundedAmount?: number;
}
const RidePaymentSummarySchema =
  SchemaFactory.createForClass(RidePaymentSummary);

@Schema({ timestamps: true, collection: "rides" })
export class Ride {
  /** Short human-friendly reference for support calls ("TR7K2M9QXA"). */
  @Prop({ required: true })
  rideCode!: string;

  @Prop({ required: true, type: SchemaTypes.ObjectId, ref: "User" })
  customerId!: Types.ObjectId;

  /** NORMAL (pickup → destination) or CIRCUIT (a package of fixed stops). Rides booked before circuits are NORMAL. */
  @Prop({ required: true, enum: RideKind, default: RideKind.NORMAL })
  kind!: RideKind;

  /**
   * Circuit rides only: the package snapshot, stop progress, usage and
   * warnings. For a circuit, `destination` is the last stop and
   * `distanceMeters`/`durationSeconds` are the route estimate.
   */
  @Prop({ type: RideCircuitSchema })
  circuit?: RideCircuit;

  /** Ride type code at booking; historical codes stay valid even if retired. */
  @Prop({ required: true })
  rideType!: string;

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

  /** Limits applied when this ride was booked (see RideDistancePolicy). */
  @Prop({ type: RideDistancePolicySchema })
  distancePolicy?: RideDistancePolicy;

  @Prop({ required: true })
  routeProvider!: string;

  /**
   * Pickup → destination road path at booking (Google encoded polyline,
   * overview quality). Absent for straight-line (HAVERSINE) estimates.
   */
  @Prop()
  routePolyline?: string;

  @Prop({ required: true, type: RideFareSchema })
  fare!: RideFare;

  @Prop({ type: RidePromoSchema })
  promo?: RidePromo;

  // ── Zone (Phase 7): the active service zone containing the pickup ──────
  @Prop({ type: SchemaTypes.ObjectId, ref: "Zone" })
  zoneId?: Types.ObjectId;

  @Prop()
  zoneName?: string;

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
  @Prop({
    required: true,
    enum: RidePaymentStatus,
    default: RidePaymentStatus.NOT_REQUIRED,
  })
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
// Reports (Phase 7): date-range scans by lifecycle timestamp and by zone.
RideSchema.index({ requestedAt: -1 });
RideSchema.index({ status: 1, completedAt: -1 });
RideSchema.index({ status: 1, cancelledAt: -1 });
RideSchema.index(
  { zoneId: 1, requestedAt: -1 },
  { partialFilterExpression: { zoneId: { $exists: true } } },
);
RideSchema.index(
  { "promo.promoId": 1 },
  { partialFilterExpression: { "promo.promoId": { $exists: true } } },
);
// Sweeper scans.
RideSchema.index({ status: 1, assignmentExpiresAt: 1 });
RideSchema.index({ status: 1, searchExpiresAt: 1 });
// Circuit lists (admin bookings, live circuits) and per-package analytics.
RideSchema.index({ kind: 1, requestedAt: -1 });
RideSchema.index(
  { "circuit.packageId": 1, requestedAt: -1 },
  { partialFilterExpression: { "circuit.packageId": { $exists: true } } },
);
// A repeated "Confirm & Book" (same Idempotency-Key) never creates a second circuit.
RideSchema.index(
  { customerId: 1, "circuit.bookingKey": 1 },
  {
    unique: true,
    partialFilterExpression: { "circuit.bookingKey": { $type: "string" } },
    name: "uniq_circuit_booking_key",
  },
);
// One active ride per customer, enforced by the database under concurrency.
RideSchema.index(
  { customerId: 1 },
  {
    unique: true,
    partialFilterExpression: { isActive: true },
    name: "uniq_active_ride_per_customer",
  },
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
