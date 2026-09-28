import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, Types } from "mongoose";
import type { HydratedDocument } from "mongoose";
import { PromoDiscountType, PromoStatus } from "../promo-rules";

export const PROMO_CODE_PATTERN = /^[A-Z0-9]{3,20}$/;

/**
 * A promo code. Discounts are platform-funded: the driver's earning is
 * computed on the full trip fare; the customer pays fare − discount.
 */
@Schema({ timestamps: true, collection: "promo_codes" })
export class PromoCode {
  @Prop({ required: true, uppercase: true, trim: true, match: PROMO_CODE_PATTERN, immutable: true })
  code!: string;

  @Prop({ required: true, trim: true })
  title!: string;

  @Prop({ trim: true })
  description?: string;

  @Prop({ required: true, enum: PromoDiscountType })
  discountType!: PromoDiscountType;

  /** Percentage (1–100) or rupees, per discountType. */
  @Prop({ required: true, min: 0 })
  discountValue!: number;

  /** Cap on the discount in rupees (typical for percentage promos). */
  @Prop({ min: 0 })
  maxDiscount?: number;

  /** Minimum server-priced fare, rupees. */
  @Prop({ min: 0 })
  minRideValue?: number;

  /** Total uses across all customers; absent = unlimited. */
  @Prop({ min: 1 })
  usageLimit?: number;

  @Prop({ required: true, min: 1, default: 1 })
  perUserLimit!: number;

  @Prop({ required: true })
  startsAt!: Date;

  @Prop({ required: true })
  endsAt!: Date;

  @Prop({ required: true, enum: PromoStatus, default: PromoStatus.ACTIVE })
  status!: PromoStatus;

  /** Ride type codes; empty = all. */
  @Prop({ type: [String], default: [] })
  applicableRideTypes!: string[];

  /** Listed in the customer app's offers. Unlisted codes still work when typed. */
  @Prop({ required: true, default: false })
  showInApp!: boolean;

  /** Reserved + redeemed uses. Maintained atomically; the global-limit guard. */
  @Prop({ required: true, default: 0, min: 0 })
  usedCount!: number;

  /** Uses on completed rides. */
  @Prop({ required: true, default: 0, min: 0 })
  redeemedCount!: number;

  /** Total discount given on completed rides, rupees. */
  @Prop({ required: true, default: 0, min: 0 })
  discountGiven!: number;

  @Prop({ type: SchemaTypes.ObjectId, ref: "User" })
  createdBy?: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: "User" })
  updatedBy?: Types.ObjectId;
}

export type PromoCodeDocument = HydratedDocument<PromoCode>;
export const PromoCodeSchema = SchemaFactory.createForClass(PromoCode);

PromoCodeSchema.index({ code: 1 }, { unique: true });
PromoCodeSchema.index({ status: 1, endsAt: 1 });
PromoCodeSchema.index({ showInApp: 1, status: 1, endsAt: 1 });

export enum PromoRedemptionStatus {
  /** Applied to a booked ride that has not finished. Counts against limits. */
  RESERVED = "RESERVED",
  /** The ride completed with the discount. */
  REDEEMED = "REDEEMED",
  /** The ride was cancelled / found no driver: the use is given back. */
  RELEASED = "RELEASED",
}

@Schema({ timestamps: true, collection: "promo_redemptions" })
export class PromoRedemption {
  @Prop({ required: true, type: SchemaTypes.ObjectId, ref: "PromoCode" })
  promoId!: Types.ObjectId;

  @Prop({ required: true })
  code!: string;

  @Prop({ required: true, type: SchemaTypes.ObjectId, ref: "User" })
  userId!: Types.ObjectId;

  @Prop({ required: true, type: SchemaTypes.ObjectId, ref: "Ride" })
  rideId!: Types.ObjectId;

  @Prop({ required: true })
  rideType!: string;

  /** Discount at booking; replaced by the final discount on redemption. */
  @Prop({ required: true, min: 0 })
  discount!: number;

  @Prop({ required: true, enum: PromoRedemptionStatus, default: PromoRedemptionStatus.RESERVED })
  status!: PromoRedemptionStatus;

  @Prop()
  redeemedAt?: Date;

  @Prop()
  releasedAt?: Date;

  createdAt?: Date;
}

export type PromoRedemptionDocument = HydratedDocument<PromoRedemption>;
export const PromoRedemptionSchema = SchemaFactory.createForClass(PromoRedemption);

// One promo per ride.
PromoRedemptionSchema.index({ rideId: 1 }, { unique: true });
// Per-user limit checks.
PromoRedemptionSchema.index({ promoId: 1, userId: 1, status: 1 });
PromoRedemptionSchema.index({ promoId: 1, createdAt: -1 });
PromoRedemptionSchema.index({ status: 1, redeemedAt: -1 });
