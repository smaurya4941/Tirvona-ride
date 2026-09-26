/**
 * The Tirvona payment record's state, aligned with Razorpay's payment
 * lifecycle. (The ride carries the customer-facing RidePaymentStatus.)
 *
 * CREATED    — a Razorpay order exists; nothing captured yet.
 * AUTHORIZED — Razorpay holds an authorised payment we have not captured.
 * CAPTURED   — money collected and verified by the backend. Success. For a
 *              CASH payment: the customer chose to pay the driver in cash.
 * FAILED     — the latest attempt failed; the customer may retry.
 * REFUNDED / PARTIALLY_REFUNDED — synced from Razorpay refund webhooks.
 */
export enum PaymentStatus {
  CREATED = "CREATED",
  AUTHORIZED = "AUTHORIZED",
  CAPTURED = "CAPTURED",
  FAILED = "FAILED",
  REFUNDED = "REFUNDED",
  PARTIALLY_REFUNDED = "PARTIALLY_REFUNDED",
}

/** Statuses from which a payment can still become CAPTURED. */
export const OPEN_PAYMENT_STATUSES: readonly PaymentStatus[] = [
  PaymentStatus.CREATED,
  PaymentStatus.AUTHORIZED,
  PaymentStatus.FAILED,
];

export const SETTLED_PAYMENT_STATUSES: readonly PaymentStatus[] = [
  PaymentStatus.CAPTURED,
  PaymentStatus.REFUNDED,
  PaymentStatus.PARTIALLY_REFUNDED,
];

/** One Razorpay order = one attempt. Retries re-use an open order. */
export enum PaymentAttemptStatus {
  CREATED = "CREATED",
  /** Razorpay has seen a payment on this order that is not final yet. */
  ATTEMPTED = "ATTEMPTED",
  PAID = "PAID",
  FAILED = "FAILED",
}

/** Who told the backend about a payment change (audit trail). */
export enum PaymentEventSource {
  CUSTOMER = "CUSTOMER",
  VERIFY = "VERIFY",
  WEBHOOK = "WEBHOOK",
  RECONCILE = "RECONCILE",
  SYSTEM = "SYSTEM",
}

/** How a payment was settled (the record's `gateway`). */
export enum PaymentGateway {
  RAZORPAY = "RAZORPAY",
  /** Handed to the driver; no gateway involved. */
  CASH = "CASH",
}

export const PAYMENT_GATEWAY = PaymentGateway.RAZORPAY;

/** `method` of a cash payment (Razorpay methods are upi, card, …). */
export const CASH_METHOD = "cash";
