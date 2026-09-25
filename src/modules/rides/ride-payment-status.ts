/**
 * The money side of a ride, deliberately separate from `RideStatus`:
 * the driver completing a trip (status COMPLETED) is not the customer paying
 * for it. A ride is financially closed only at SUCCESS.
 *
 *   NOT_REQUIRED ──(ride COMPLETED, final fare set)──▶ PENDING
 *   PENDING / FAILED ──(Razorpay order created)──▶ ORDER_CREATED
 *   ORDER_CREATED ──(gateway reports a payment, not yet confirmed)──▶ PROCESSING
 *   ORDER_CREATED / PROCESSING ──(verified + captured)──▶ SUCCESS
 *   ORDER_CREATED / PROCESSING ──(declined / abandoned)──▶ FAILED ──▶ retry
 *   SUCCESS ──(refund synced from Razorpay)──▶ REFUNDED / PARTIALLY_REFUNDED
 *
 * NOT_REQUIRED covers rides with nothing to pay: still in progress,
 * cancelled, or never matched. CANCELLED is reserved for a payable ride
 * written off by operations (no customer path reaches it in V1).
 */
export enum RidePaymentStatus {
  NOT_REQUIRED = "NOT_REQUIRED",
  PENDING = "PENDING",
  ORDER_CREATED = "ORDER_CREATED",
  PROCESSING = "PROCESSING",
  SUCCESS = "SUCCESS",
  FAILED = "FAILED",
  CANCELLED = "CANCELLED",
  REFUNDED = "REFUNDED",
  PARTIALLY_REFUNDED = "PARTIALLY_REFUNDED",
}

/** States in which the customer can (still) start or retry a payment. */
export const PAYABLE_RIDE_PAYMENT_STATUSES: readonly RidePaymentStatus[] = [
  RidePaymentStatus.PENDING,
  RidePaymentStatus.ORDER_CREATED,
  RidePaymentStatus.PROCESSING,
  RidePaymentStatus.FAILED,
];

/** The customer has paid (a later refund does not reopen the ride). */
export const PAID_RIDE_PAYMENT_STATUSES: readonly RidePaymentStatus[] = [
  RidePaymentStatus.SUCCESS,
  RidePaymentStatus.REFUNDED,
  RidePaymentStatus.PARTIALLY_REFUNDED,
];

/**
 * The payment status to act on. Rides completed before Phase 4 carry the
 * schema default (NOT_REQUIRED) but do owe their final fare.
 */
export function effectivePaymentStatus(ride: {
  status: string;
  paymentStatus?: RidePaymentStatus;
  fare?: { finalFare?: number };
}): RidePaymentStatus {
  const stored = ride.paymentStatus ?? RidePaymentStatus.NOT_REQUIRED;
  if (stored === RidePaymentStatus.NOT_REQUIRED && ride.status === "COMPLETED" && (ride.fare?.finalFare ?? 0) > 0)
    return RidePaymentStatus.PENDING;
  return stored;
}
