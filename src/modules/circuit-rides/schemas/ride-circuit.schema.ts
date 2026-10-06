import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, Types } from "mongoose";
import { CircuitExceptionType, CircuitStopStatus } from "../circuit-ride.types";

/** One stop of a booked circuit: a copy of the package stop plus this trip's progress. */
@Schema({ _id: false })
export class RideCircuitStop {
  @Prop({ required: true, min: 1 })
  order!: number;

  @Prop({ required: true })
  placeId!: string;

  @Prop({ required: true })
  name!: string;

  @Prop({ required: true })
  address!: string;

  @Prop({ required: true })
  latitude!: number;

  @Prop({ required: true })
  longitude!: number;

  @Prop({
    required: true,
    enum: CircuitStopStatus,
    default: CircuitStopStatus.UPCOMING,
  })
  status!: CircuitStopStatus;

  @Prop()
  arrivedAt?: Date;

  @Prop()
  waitingAt?: Date;

  @Prop()
  completedAt?: Date;

  @Prop()
  skippedAt?: Date;
}
const RideCircuitStopSchema = SchemaFactory.createForClass(RideCircuitStop);

/** The package tariff in force when this circuit was booked. Admin edits never reach it. */
@Schema({ _id: false })
export class RideCircuitPricing {
  @Prop({ required: true, min: 0 })
  basePrice!: number;

  @Prop({ required: true, min: 0 })
  includedDistanceMeters!: number;

  @Prop({ required: true, min: 0 })
  includedDurationSeconds!: number;

  @Prop({ required: true, min: 0 })
  extraDistanceRatePerKm!: number;

  @Prop({ required: true, min: 0 })
  extraDurationRatePerHour!: number;
}
const RideCircuitPricingSchema =
  SchemaFactory.createForClass(RideCircuitPricing);

/** How much of the package this trip has used. Written by the circuit monitor; completion re-measures. */
@Schema({ _id: false })
export class RideCircuitUsage {
  @Prop({ required: true, min: 0, default: 0 })
  distanceMeters!: number;

  /** False while the GPS trail is too sparse or glitchy to bill on. */
  @Prop({ required: true, default: true })
  reliable!: boolean;

  @Prop()
  measuredAt?: Date;
}
const RideCircuitUsageSchema = SchemaFactory.createForClass(RideCircuitUsage);

/** When each usage warning was sent: each is sent once per circuit. */
@Schema({ _id: false })
export class RideCircuitWarnings {
  @Prop()
  time30At?: Date;

  @Prop()
  time10At?: Date;

  @Prop()
  timeExhaustedAt?: Date;

  @Prop()
  distance80At?: Date;

  @Prop()
  distanceExhaustedAt?: Date;
}
const RideCircuitWarningsSchema =
  SchemaFactory.createForClass(RideCircuitWarnings);

/** An open operational exception (e.g. a blocked stop). While set, the driver cannot progress. */
@Schema({ _id: false })
export class RideCircuitException {
  @Prop({ required: true, enum: CircuitExceptionType })
  type!: CircuitExceptionType;

  @Prop({ required: true })
  stopOrder!: number;

  @Prop({ trim: true })
  note?: string;

  @Prop({ required: true })
  reportedAt!: Date;

  @Prop({ type: SchemaTypes.ObjectId, ref: "User" })
  reportedBy?: Types.ObjectId;
}
const RideCircuitExceptionSchema =
  SchemaFactory.createForClass(RideCircuitException);

/** How the final fare was reached: what the circuit used beyond the package. Frozen at completion. */
@Schema({ _id: false })
export class RideCircuitSettlement {
  @Prop({ required: true, min: 0 })
  usedDistanceMeters!: number;

  @Prop({ required: true, min: 0 })
  usedDurationSeconds!: number;

  /** ACTUAL (GPS trail) or BOOKED (the trail was not reliable, so the booked route was used). */
  @Prop({ required: true })
  distanceSource!: string;

  @Prop({ required: true, min: 0 })
  extraKm!: number;

  @Prop({ required: true, min: 0 })
  extraBlocks!: number;

  /** DRIVER (every stop done) or ADMIN (ended early by support). */
  @Prop({ required: true })
  completedBy!: string;
}
const RideCircuitSettlementSchema = SchemaFactory.createForClass(
  RideCircuitSettlement,
);

/** What the customer was shown and agreed to; a frozen copy of the package at booking. */
@Schema({ _id: false })
export class RideCircuit {
  @Prop({ required: true, type: SchemaTypes.ObjectId, ref: "CircuitPackage" })
  packageId!: Types.ObjectId;

  @Prop({ required: true })
  packageCode!: string;

  /** The package revision this booking was priced on. */
  @Prop({ required: true })
  packageRevision!: number;

  @Prop({ required: true })
  name!: string;

  @Prop({ required: true })
  city!: string;

  @Prop({ required: true, min: 1 })
  passengers!: number;

  @Prop({ type: [RideCircuitStopSchema], default: [] })
  stops!: RideCircuitStop[];

  @Prop({ required: true, type: RideCircuitPricingSchema })
  pricing!: RideCircuitPricing;

  @Prop({ trim: true })
  cancellationPolicy?: string;

  /**
   * 1-based order of the stop being worked on once the circuit has started
   * (0 before the start); stops.length + 1 once every stop is done and the
   * circuit is ready to be completed.
   */
  @Prop({ required: true, default: 0 })
  currentStopOrder!: number;

  @Prop({ type: RideCircuitUsageSchema, default: () => ({}) })
  usage!: RideCircuitUsage;

  @Prop({ type: RideCircuitWarningsSchema, default: () => ({}) })
  warnings!: RideCircuitWarnings;

  @Prop({ type: RideCircuitExceptionSchema })
  exception?: RideCircuitException;

  @Prop({ type: RideCircuitSettlementSchema })
  settlement?: RideCircuitSettlement;

  /** Set when Admin ended the circuit early rather than the driver completing every stop. */
  @Prop({ trim: true })
  endedEarlyReason?: string;

  /** Client-supplied Idempotency-Key of the booking request, unique per customer. */
  @Prop()
  bookingKey?: string;
}
export const RideCircuitSchema = SchemaFactory.createForClass(RideCircuit);
