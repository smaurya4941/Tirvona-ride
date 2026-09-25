/**
 * PENDING   — the customer's payment succeeded; the settlement window
 *             (EARNINGS_HOLD_HOURS) has not passed yet.
 * AVAILABLE — owed to the driver; can be included in a manual payout.
 * PAID      — an admin recorded a payout that covered it.
 */
export enum EarningStatus {
  PENDING = "PENDING",
  AVAILABLE = "AVAILABLE",
  PAID = "PAID",
}

/** V1 supports percentage commission only; the field exists for later types. */
export enum CommissionType {
  PERCENTAGE = "PERCENTAGE",
}

export enum CommissionConfigStatus {
  /** Applies from `effectiveFrom` until a later version takes over. */
  ACTIVE = "ACTIVE",
  /** A scheduled change an admin withdrew before it took effect. */
  CANCELLED = "CANCELLED",
}

/** How a commission version relates to "now" — derived, never stored. */
export enum CommissionPhase {
  SCHEDULED = "SCHEDULED",
  CURRENT = "CURRENT",
  SUPERSEDED = "SUPERSEDED",
  CANCELLED = "CANCELLED",
}

export enum EarningsPeriod {
  TODAY = "today",
  WEEK = "week",
  MONTH = "month",
  ALL = "all",
}
