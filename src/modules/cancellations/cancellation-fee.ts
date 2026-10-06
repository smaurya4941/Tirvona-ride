import { RideActorType, RideStatus } from "../rides/ride-state-machine";

/**
 * The customer cancellation-fee rule. Every number is an admin-configured
 * business decision; the seeded policy is DISABLED with all amounts zero, so
 * no customer is ever charged until Tirvona locks and enters its rules.
 *
 * V1 scope (documented in docs/phase-7): only customers can be charged, and
 * only after a driver has committed (accepted) — before that nobody has
 * spent time or fuel on the ride. Driver cancellations are recorded and
 * reported but carry no monetary penalty.
 */
export interface CustomerFeeRule {
  enabled: boolean;
  /** Free-cancellation window after the driver accepts, seconds. */
  graceSeconds: number;
  /** Flat part of the fee, rupees. */
  fixedFee: number;
  /** Percentage of the booked (estimated) fare, 0–100. */
  percentOfFare: number;
  /** Upper bound on the fee, rupees; 0 = no cap beyond the fare itself. */
  maxFee: number;
  /** Ride statuses in which the fee may apply. */
  applicableStatuses: RideStatus[];
}

/** Statuses in which a charge is even conceivable (driver committed, trip not started). */
export const FEE_ELIGIBLE_STATUSES: readonly RideStatus[] = [
  RideStatus.DRIVER_ACCEPTED,
  RideStatus.DRIVER_ARRIVED,
];

export const DISABLED_CUSTOMER_FEE_RULE: CustomerFeeRule = {
  enabled: false,
  graceSeconds: 0,
  fixedFee: 0,
  percentOfFare: 0,
  maxFee: 0,
  applicableStatuses: [...FEE_ELIGIBLE_STATUSES],
};

export interface FeeContext {
  actor: RideActorType;
  status: RideStatus;
  acceptedAt?: Date;
  now: Date;
  /** Booked fare the percentage applies to, rupees. */
  fare: number;
}

export interface FeeAssessment {
  amount: number;
  applies: boolean;
  /** One line the app and the admin panel can show verbatim. */
  explanation: string;
  /** When a currently-free cancellation starts to cost money. */
  freeUntil?: Date;
}

const none = (explanation: string, freeUntil?: Date): FeeAssessment => ({
  amount: 0,
  applies: false,
  explanation,
  freeUntil,
});

/** Pure and deterministic: same rule + context → same fee. Whole rupees. */
export function assessCancellationFee(
  rule: CustomerFeeRule,
  context: FeeContext,
): FeeAssessment {
  if (context.actor !== RideActorType.CUSTOMER)
    return none("No fee for this cancellation");
  if (!rule.enabled) return none("Free cancellation");
  if (
    !FEE_ELIGIBLE_STATUSES.includes(context.status) ||
    !rule.applicableStatuses.includes(context.status)
  )
    return none("Free cancellation — no driver is on the way yet");
  if (!context.acceptedAt)
    return none("Free cancellation — no driver is on the way yet");

  const freeUntil = new Date(
    context.acceptedAt.getTime() + Math.max(0, rule.graceSeconds) * 1000,
  );
  if (context.now < freeUntil)
    return none("Free cancellation for a little longer", freeUntil);

  const raw =
    Math.max(0, rule.fixedFee) +
    (Math.max(0, context.fare) *
      Math.min(100, Math.max(0, rule.percentOfFare))) /
      100;
  let amount = Math.round(raw);
  if (rule.maxFee > 0) amount = Math.min(amount, Math.round(rule.maxFee));
  amount = Math.min(amount, Math.round(Math.max(0, context.fare)));
  if (amount <= 0) return none("Free cancellation");
  return {
    amount,
    applies: true,
    explanation: `A cancellation fee of ₹${amount} applies because your driver is already on the way`,
  };
}
