/**
 * A refund's life, aligned with Razorpay's refund entity:
 *
 *   REQUESTED ──(Razorpay accepted)──▶ PENDING ──▶ PROCESSED
 *       │                                 └──────▶ FAILED
 *       └──(Razorpay rejected / never registered it)──▶ FAILED
 *
 * REQUESTED means our record exists and the amount is reserved, but Razorpay
 * has not confirmed the refund yet (e.g. the create call timed out). The
 * reconciler looks it up at Razorpay by our refund id in the notes.
 */
export enum RefundStatus {
  REQUESTED = "REQUESTED",
  PENDING = "PENDING",
  PROCESSED = "PROCESSED",
  FAILED = "FAILED",
}

/** Statuses that hold (reserve) part of the refundable amount. */
export const ACTIVE_REFUND_STATUSES: readonly RefundStatus[] = [
  RefundStatus.REQUESTED,
  RefundStatus.PENDING,
  RefundStatus.PROCESSED,
];

export enum RefundReason {
  ADMIN_REFUND = "ADMIN_REFUND",
  RIDE_CANCELLED = "RIDE_CANCELLED",
  FARE_ADJUSTMENT = "FARE_ADJUSTMENT",
  CUSTOMER_SUPPORT = "CUSTOMER_SUPPORT",
  DUPLICATE_PAYMENT = "DUPLICATE_PAYMENT",
  SYSTEM_ERROR = "SYSTEM_ERROR",
  /** Made in the Razorpay dashboard, not through Tirvona. */
  EXTERNAL = "EXTERNAL",
}

/** Which captured Razorpay payment the refund returns money from. */
export enum RefundTarget {
  /** The ride's settled payment (revenue). */
  PAYMENT = "PAYMENT",
  /** A second capture on an already-paid ride (never revenue). */
  DUPLICATE_CAPTURE = "DUPLICATE_CAPTURE",
}

/** Whether the driver's earning is reduced by this refund. */
export enum RefundDriverImpact {
  /** The driver gives back their share of the refunded fraction. */
  PROPORTIONAL = "PROPORTIONAL",
  /** Tirvona bears the refund alone. */
  NONE = "NONE",
}

/** Default driver impact per reason (the admin may override it). */
export const DEFAULT_DRIVER_IMPACT: Record<RefundReason, RefundDriverImpact> = {
  [RefundReason.ADMIN_REFUND]: RefundDriverImpact.PROPORTIONAL,
  [RefundReason.RIDE_CANCELLED]: RefundDriverImpact.PROPORTIONAL,
  [RefundReason.FARE_ADJUSTMENT]: RefundDriverImpact.PROPORTIONAL,
  [RefundReason.CUSTOMER_SUPPORT]: RefundDriverImpact.NONE,
  [RefundReason.DUPLICATE_PAYMENT]: RefundDriverImpact.NONE,
  [RefundReason.SYSTEM_ERROR]: RefundDriverImpact.NONE,
  [RefundReason.EXTERNAL]: RefundDriverImpact.NONE,
};

/** Who created the refund record. */
export enum RefundSource {
  ADMIN = "ADMIN",
  /** Discovered from a webhook (dashboard refund). */
  WEBHOOK = "WEBHOOK",
  /** Discovered by reconciliation (dashboard refund). */
  RECONCILE = "RECONCILE",
}

/** State of applying the refund to the driver ledger. */
export enum RefundLedgerState {
  /** Not due yet (refund not processed) or waiting for the earning line. */
  PENDING = "PENDING",
  RECORDED = "RECORDED",
  NOT_APPLICABLE = "NOT_APPLICABLE",
}

/** Payment-level summary of its refunds (customer money only, never duplicates). */
export enum PaymentRefundState {
  NONE = "NONE",
  /** A refund is on its way (requested or pending at Razorpay). */
  PENDING = "PENDING",
  PARTIAL = "PARTIAL",
  FULL = "FULL",
  /** The latest refund failed and nothing was refunded. */
  FAILED = "FAILED",
}
