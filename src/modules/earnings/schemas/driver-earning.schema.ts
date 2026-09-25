import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, Types } from "mongoose";
import type { HydratedDocument } from "mongoose";
import { CommissionType, EarningStatus } from "../interfaces/earning-status";

/**
 * One immutable ledger line per paid ride: what the customer paid, what
 * Tirvona kept, and what the driver is owed — with the commission rate
 * captured at the moment the line was written. A later commission change
 * never alters an existing line.
 *
 * Amounts are integer paise. Every financial field is `immutable`, so even
 * a buggy update cannot rewrite history; only the payout lifecycle
 * (status/availableAt/payout*) ever changes after insert.
 *
 * `rideId` and `paymentId` are unique: retries, duplicate verifies and
 * repeated webhooks can never produce a second line for the same ride.
 */
@Schema({ timestamps: true, collection: "driver_earnings" })
export class DriverEarning {
  @Prop({ required: true, type: SchemaTypes.ObjectId, ref: "DriverProfile", immutable: true })
  driverId!: Types.ObjectId;

  @Prop({ required: true, type: SchemaTypes.ObjectId, ref: "User", immutable: true })
  driverUserId!: Types.ObjectId;

  @Prop({ required: true, type: SchemaTypes.ObjectId, ref: "Ride", immutable: true })
  rideId!: Types.ObjectId;

  @Prop({ required: true, type: SchemaTypes.ObjectId, ref: "Payment", immutable: true })
  paymentId!: Types.ObjectId;

  // ── Ride snapshot (so the ledger reads without joins) ─────────────────
  @Prop({ required: true, immutable: true })
  rideCode!: string;

  @Prop({ required: true, immutable: true })
  rideType!: string;

  @Prop({ immutable: true })
  pickupAddress?: string;

  @Prop({ immutable: true })
  destinationAddress?: string;

  /** Business date of the earning ("today", "this week" are based on it). */
  @Prop({ required: true, immutable: true })
  rideCompletedAt!: Date;

  // ── Money (paise) ─────────────────────────────────────────────────────
  @Prop({ required: true, default: "INR", immutable: true })
  currency!: string;

  @Prop({ required: true, min: 0, immutable: true })
  grossFarePaise!: number;

  @Prop({ required: true, enum: CommissionType, immutable: true })
  commissionType!: CommissionType;

  /** Percent, e.g. 20 or 17.5 — the rate in force when this line was written. */
  @Prop({ required: true, min: 0, max: 100, immutable: true })
  commissionRate!: number;

  @Prop({ required: true, min: 0, immutable: true })
  commissionPaise!: number;

  @Prop({ required: true, min: 0, immutable: true })
  netEarningPaise!: number;

  /** The commission version applied (audit trail). */
  @Prop({ required: true, type: SchemaTypes.ObjectId, ref: "CommissionConfig", immutable: true })
  commissionConfigId!: Types.ObjectId;

  @Prop({ required: true, immutable: true })
  commissionVersion!: number;

  // ── Payout lifecycle ──────────────────────────────────────────────────
  @Prop({ required: true, enum: EarningStatus })
  status!: EarningStatus;

  /** When a PENDING line becomes AVAILABLE (end of the settlement window). */
  @Prop({ required: true })
  availableAt!: Date;

  @Prop({ type: SchemaTypes.ObjectId, ref: "DriverPayout" })
  payoutId?: Types.ObjectId;

  @Prop()
  paidAt?: Date;

  @Prop({ type: SchemaTypes.ObjectId, ref: "User" })
  paidBy?: Types.ObjectId;

  @Prop({ trim: true })
  payoutReference?: string;

  @Prop({ trim: true })
  payoutNote?: string;
}

export type DriverEarningDocument = HydratedDocument<DriverEarning>;
export const DriverEarningSchema = SchemaFactory.createForClass(DriverEarning);

DriverEarningSchema.index({ rideId: 1 }, { unique: true, name: "uniq_earning_per_ride" });
DriverEarningSchema.index({ paymentId: 1 }, { unique: true, name: "uniq_earning_per_payment" });
DriverEarningSchema.index({ driverId: 1, rideCompletedAt: -1 });
DriverEarningSchema.index({ driverId: 1, status: 1 });
// Settlement-window promotion sweep.
DriverEarningSchema.index({ status: 1, availableAt: 1 });
DriverEarningSchema.index({ payoutId: 1 }, { sparse: true });
