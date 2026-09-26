/**
 * PENDING   — the customer's payment succeeded; the settlement window
 *             (EARNINGS_HOLD_HOURS) has not passed yet.
 * AVAILABLE — owed to the driver; can be included in a manual payout.
 * PAID      — an admin recorded a payout that covered it.
 * COLLECTED — a cash ride: the driver already holds the whole fare, so
 *             nothing is paid out; Tirvona's commission is owed *by* the
 *             driver instead (reported as `commissionDue`).
 */
export enum EarningStatus {
  PENDING = "PENDING",
  AVAILABLE = "AVAILABLE",
  PAID = "PAID",
  COLLECTED = "COLLECTED",
}

/** Who received the customer's money for a ride. */
export enum PaymentMode {
  /** Paid through Razorpay: Tirvona holds it and pays the driver out. */
  ONLINE = "ONLINE",
  /** Paid to the driver in cash. */
  CASH = "CASH",
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
