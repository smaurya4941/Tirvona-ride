import { PAID_RIDE_PAYMENT_STATUSES, effectivePaymentStatus } from "../rides/ride-payment-status";
import type { RidePaymentStatus } from "../rides/ride-payment-status";
import { RideStatus } from "../rides/ride-state-machine";

/** Why a ride cannot be rated right now (machine-readable, for the app). */
export enum RatingBlocker {
  RIDE_NOT_COMPLETED = "RIDE_NOT_COMPLETED",
  PAYMENT_NOT_VERIFIED = "PAYMENT_NOT_VERIFIED",
  NO_DRIVER = "NO_DRIVER",
  WINDOW_CLOSED = "WINDOW_CLOSED",
  ALREADY_RATED = "ALREADY_RATED",
}

export interface RateableRide {
  status: RideStatus | string;
  paymentStatus?: RidePaymentStatus;
  fare?: { finalFare?: number };
  driverId?: unknown;
  completedAt?: Date;
}

export interface RatingEligibility {
  canRate: boolean;
  reason?: RatingBlocker;
  /** Last moment a rating is accepted (completedAt + window). */
  windowEndsAt?: Date;
}

/**
 * Customer → driver rating rule (ownership is checked by the caller):
 * COMPLETED + payment verified + a driver + inside the window + not yet rated.
 * A later refund does not take the right to rate away: the trip happened.
 */
export function ratingEligibility(
  ride: RateableRide,
  alreadyRated: boolean,
  windowDays: number,
  now: Date = new Date(),
): RatingEligibility {
  const windowEndsAt = ride.completedAt
    ? new Date(ride.completedAt.getTime() + windowDays * 24 * 60 * 60 * 1000)
    : undefined;
  const blocked = (reason: RatingBlocker): RatingEligibility => ({ canRate: false, reason, windowEndsAt });

  if (alreadyRated) return blocked(RatingBlocker.ALREADY_RATED);
  if (ride.status !== RideStatus.COMPLETED) return blocked(RatingBlocker.RIDE_NOT_COMPLETED);
  if (!ride.driverId) return blocked(RatingBlocker.NO_DRIVER);
  // Explicit fields: `ride` may be a hydrated Mongoose document, whose
  // properties are getters that an object spread would not copy.
  const paymentStatus = effectivePaymentStatus({
    status: String(ride.status),
    paymentStatus: ride.paymentStatus,
    fare: { finalFare: ride.fare?.finalFare },
  });
  if (!PAID_RIDE_PAYMENT_STATUSES.includes(paymentStatus))
    return blocked(RatingBlocker.PAYMENT_NOT_VERIFIED);
  if (windowEndsAt && now > windowEndsAt) return blocked(RatingBlocker.WINDOW_CLOSED);
  return { canRate: true, windowEndsAt };
}
