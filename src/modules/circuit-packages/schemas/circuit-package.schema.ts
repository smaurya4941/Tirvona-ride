import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, Types } from "mongoose";
import type { HydratedDocument } from "mongoose";
import { CircuitPackageStatus } from "../circuit-package.types";

/** One fixed destination. Identity is the provider place id plus coordinates, never just the name. */
@Schema({ _id: false })
export class CircuitPackageStop {
  /** 1-based position in the circuit. */
  @Prop({ required: true, min: 1 })
  order!: number;

  /** Provider-prefixed place id ("google:ChIJ…", "osm:N123"), picked from the Places search. */
  @Prop({ required: true, trim: true })
  placeId!: string;

  @Prop({ required: true, trim: true })
  name!: string;

  @Prop({ required: true, trim: true })
  address!: string;

  @Prop({ required: true, min: -90, max: 90 })
  latitude!: number;

  @Prop({ required: true, min: -180, max: 180 })
  longitude!: number;
}
const CircuitPackageStopSchema = SchemaFactory.createForClass(CircuitPackageStop);

@Schema({ _id: false })
export class CircuitPackagePricing {
  /** What the customer pays for the included distance and time, rupees. */
  @Prop({ required: true, min: 0 })
  basePrice!: number;

  @Prop({ required: true, min: 0 })
  includedDistanceMeters!: number;

  @Prop({ required: true, min: 0 })
  includedDurationSeconds!: number;

  /** Rupees per extra km, charged per started km. */
  @Prop({ required: true, min: 0 })
  extraDistanceRatePerKm!: number;

  /** Rupees per extra hour, charged per started 15 minutes. */
  @Prop({ required: true, min: 0 })
  extraDurationRatePerHour!: number;
}
const CircuitPackagePricingSchema = SchemaFactory.createForClass(CircuitPackagePricing);

@Schema({ _id: false })
export class CircuitPackageAvailability {
  /** 0 = Monday … 6 = Sunday. */
  @Prop({ type: [Number], default: [0, 1, 2, 3, 4, 5, 6] })
  days!: number[];

  /** "HH:mm" in APP_TIME_ZONE; the circuit may be booked from `opensAt` until `closesAt` (exclusive). */
  @Prop({ required: true, default: "06:00" })
  opensAt!: string;

  @Prop({ required: true, default: "20:00" })
  closesAt!: string;

  /** Optional season window, "YYYY-MM-DD" in APP_TIME_ZONE (both inclusive). */
  @Prop()
  validFrom?: string;

  @Prop()
  validUntil?: string;
}
const CircuitPackageAvailabilitySchema = SchemaFactory.createForClass(CircuitPackageAvailability);

/** The reference origin Admin uses to judge viability (customers book from anywhere). */
@Schema({ _id: false })
export class CircuitReferenceOrigin {
  @Prop({ required: true, trim: true })
  label!: string;

  @Prop({ required: true, min: -90, max: 90 })
  latitude!: number;

  @Prop({ required: true, min: -180, max: 180 })
  longitude!: number;
}
const CircuitReferenceOriginSchema = SchemaFactory.createForClass(CircuitReferenceOrigin);

@Schema({ _id: false })
export class CircuitPackageCover {
  @Prop({ required: true })
  contentType!: string;

  @Prop({ required: true, select: false })
  data!: Buffer;

  @Prop({ required: true })
  version!: string;

  @Prop({ required: true })
  width!: number;

  @Prop({ required: true })
  height!: number;

  @Prop({ required: true })
  bytes!: number;
}
const CircuitPackageCoverSchema = SchemaFactory.createForClass(CircuitPackageCover);

/**
 * A product Admin configures — not a ride. A package lives for months; every
 * booking copies what it needs into the ride (see RideCircuit), so editing a
 * package never touches a booking that already exists.
 */
@Schema({ timestamps: true, collection: "circuit_packages" })
export class CircuitPackage {
  /** Human code, "VRC-001". Immutable once issued. */
  @Prop({ required: true, immutable: true })
  code!: string;

  @Prop({ required: true, trim: true })
  name!: string;

  @Prop({ trim: true, default: "" })
  description!: string;

  @Prop({ required: true, trim: true })
  city!: string;

  @Prop({ required: true, enum: CircuitPackageStatus, default: CircuitPackageStatus.DRAFT })
  status!: CircuitPackageStatus;

  @Prop({ type: [CircuitPackageStopSchema], default: [] })
  stops!: CircuitPackageStop[];

  @Prop({ type: CircuitPackagePricingSchema })
  pricing?: CircuitPackagePricing;

  /** Ride type codes (AUTO, E_RICKSHAW, CAB, …) the package can be booked with. */
  @Prop({ type: [String], default: [] })
  rideTypes!: string[];

  @Prop({ required: true, min: 1, max: 8, default: 4 })
  maxPassengers!: number;

  @Prop({ type: CircuitPackageAvailabilitySchema, default: () => ({}) })
  availability!: CircuitPackageAvailability;

  @Prop({ trim: true })
  cancellationPolicy?: string;

  @Prop({ type: CircuitReferenceOriginSchema })
  referenceOrigin?: CircuitReferenceOrigin;

  @Prop({ type: CircuitPackageCoverSchema })
  cover?: CircuitPackageCover;

  /**
   * Bumped whenever something a customer is quoted changes (stops, pricing,
   * ride types, capacity). Bookings record the revision they were priced on.
   */
  @Prop({ required: true, default: 1 })
  revision!: number;

  /** Set once any customer has booked it: such a package can be archived but never deleted. */
  @Prop({ required: true, default: false })
  hasBookings!: boolean;

  @Prop({ type: SchemaTypes.ObjectId, ref: "User" })
  createdBy?: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: "User" })
  updatedBy?: Types.ObjectId;

  @Prop()
  publishedAt?: Date;
}

export type CircuitPackageDocument = HydratedDocument<CircuitPackage>;
export const CircuitPackageSchema = SchemaFactory.createForClass(CircuitPackage);

CircuitPackageSchema.index({ code: 1 }, { unique: true });
CircuitPackageSchema.index({ status: 1, city: 1, name: 1 });
CircuitPackageSchema.index({ updatedAt: -1 });

/** Atomic counter for "VRC-001" style codes. */
@Schema({ collection: "circuit_package_counters" })
export class CircuitPackageCounter {
  @Prop({ required: true })
  _id!: string;

  @Prop({ required: true, default: 0 })
  seq!: number;
}
export const CircuitPackageCounterSchema = SchemaFactory.createForClass(CircuitPackageCounter);
