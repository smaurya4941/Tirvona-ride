import type { ErrorCode } from "../../common/constants/error-codes";

export enum PromoDiscountType {
  /** discountValue is a percentage of the fare (1–100), capped by maxDiscount. */
  PERCENTAGE = "PERCENTAGE",
  /** discountValue is a fixed rupee amount. */
  FLAT = "FLAT",
}

export enum PromoStatus {
  ACTIVE = "ACTIVE",
  INACTIVE = "INACTIVE",
}

/**
 * The customer always pays at least this much, so every discounted ride
 * still produces a real payment (Razorpay's minimum is ₹1) and a driver
 * earning line. A promo can never make a ride free.
 */
export const MIN_PAYABLE_RUPEES = 1;

/** The part of a promo needed to price a discount — also snapshotted on the ride. */
export interface PromoDiscountRules {
  discountType: PromoDiscountType;
  discountValue: number;
  maxDiscount?: number;
}

export interface PromoEligibilityRules extends PromoDiscountRules {
  status: PromoStatus;
  startsAt: Date;
  endsAt: Date;
  minRideValue?: number;
  /** Empty = every ride type. */
  applicableRideTypes: string[];
  usageLimit?: number | null;
  usedCount: number;
  perUserLimit: number;
}

export interface PromoContext {
  now: Date;
  rideType: string;
  /** Server-priced fare (rupees) the discount applies to. */
  fare: number;
  /** This customer's reserved + redeemed uses of the promo. */
  userUses: number;
}

export type PromoEvaluation =
  | { ok: true; discount: number; payable: number }
  | { ok: false; code: ErrorCode; message: string };

/**
 * Discount in whole rupees (fares are whole rupees), rounded down, capped by
 * maxDiscount and by fare − ₹1. Pure and deterministic.
 */
export function computeDiscount(rules: PromoDiscountRules, fare: number): number {
  if (!Number.isFinite(fare) || fare <= MIN_PAYABLE_RUPEES) return 0;
  const raw =
    rules.discountType === PromoDiscountType.PERCENTAGE
      ? Math.floor((fare * Math.min(100, Math.max(0, rules.discountValue))) / 100)
      : Math.floor(Math.max(0, rules.discountValue));
  const capped = rules.maxDiscount !== undefined && rules.maxDiscount !== null ? Math.min(raw, Math.floor(rules.maxDiscount)) : raw;
  return Math.max(0, Math.min(capped, Math.floor(fare - MIN_PAYABLE_RUPEES)));
}

const fail = (code: ErrorCode, message: string): PromoEvaluation => ({ ok: false, code, message });

const rupees = (value: number): string => `₹${Number.isInteger(value) ? value : value.toFixed(2)}`;

/**
 * Every check the backend runs before a promo may be applied, in the order
 * the customer should hear about them. The app never decides validity.
 */
export function evaluatePromo(promo: PromoEligibilityRules, context: PromoContext): PromoEvaluation {
  if (promo.status !== PromoStatus.ACTIVE) return fail("PROMO_INACTIVE", "This promo code is not active");
  if (context.now < promo.startsAt) return fail("PROMO_NOT_STARTED", "This promo code is not valid yet");
  if (context.now >= promo.endsAt) return fail("PROMO_EXPIRED", "This promo code has expired");
  if (promo.applicableRideTypes.length > 0 && !promo.applicableRideTypes.includes(context.rideType))
    return fail("PROMO_RIDE_TYPE_NOT_ELIGIBLE", "This promo code cannot be used for this ride type");
  if (promo.minRideValue !== undefined && promo.minRideValue !== null && context.fare < promo.minRideValue)
    return fail("PROMO_MIN_FARE_NOT_MET", `This promo code needs a fare of at least ${rupees(promo.minRideValue)}`);
  if (promo.usageLimit !== undefined && promo.usageLimit !== null && promo.usedCount >= promo.usageLimit)
    return fail("PROMO_USAGE_LIMIT_REACHED", "This promo code has been fully used");
  if (context.userUses >= promo.perUserLimit)
    return fail("PROMO_USER_LIMIT_REACHED", "You have already used this promo code");

  const discount = computeDiscount(promo, context.fare);
  if (discount <= 0) return fail("PROMO_MIN_FARE_NOT_MET", "This fare is too low for this promo code");
  return { ok: true, discount, payable: context.fare - discount };
}
