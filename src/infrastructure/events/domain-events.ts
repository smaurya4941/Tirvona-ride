import type { RidePaymentStatus } from "../../modules/rides/ride-payment-status";
import type {
  RideActorType,
  RideStatus,
} from "../../modules/rides/ride-state-machine";

/**
 * What a ride looked like right after a committed change — only the fields
 * downstream consumers (notifications, share links) need, so they never
 * have to re-read the ride just to phrase a message.
 */
export interface RideSnapshot {
  rideId: string;
  rideCode: string;
  status: RideStatus;
  stateVersion: number;
  customerId: string;
  driverId?: string;
  driverUserId?: string;
  pickupAddress: string;
  destinationAddress: string;
  finalFare?: number;
  estimatedFare: number;
  currency: string;
  cancelledBy?: RideActorType;
  cancellationReason?: string;
  /** Phase 7: promo applied at booking, and its (final, once completed) discount. */
  promoCode?: string;
  promoDiscount?: number;
  /** What the customer pays when it differs from the fare (promo). */
  payableFare?: number;
  cancellationFee?: number;
  zoneId?: string;
  /** Set for circuit rides: the package name, so messages say "your circuit" rather than "your trip to <last stop>". */
  circuitName?: string;
}

export interface RideTransitionedEvent {
  ride: RideSnapshot;
  from?: RideStatus;
  to: RideStatus;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export interface RideDriverArrivingEvent {
  rideId: string;
  driverId: string;
  etaSeconds?: number;
  distanceMeters?: number;
}

/** The driver asked to end the trip: the customer must share the end-of-trip OTP. */
export interface RideEndRequestedEvent {
  ride: RideSnapshot;
}

export interface RidePaymentUpdatedEvent {
  ride: RideSnapshot;
  paymentStatus: RidePaymentStatus;
  amount?: number;
  /** "cash", or Razorpay's method (upi, card, …) once paid. */
  method?: string;
}

/** A refund was requested, or Razorpay moved it (pending → processed / failed). */
export interface PaymentRefundUpdatedEvent {
  refundId: string;
  paymentId: string;
  rideId: string;
  rideCode: string;
  customerId: string;
  /** Rupees. */
  amount: number;
  currency: string;
  /** RefundStatus */
  status: string;
  /** RefundTarget: PAYMENT or DUPLICATE_CAPTURE. */
  target: string;
  /** Whether this update changed the status (vs. a repeated report). */
  changed: boolean;
}

/** A driver's earnings were reduced after the ride (refund clawback). */
export interface EarningsAdjustedEvent {
  adjustmentId: string;
  driverUserId: string;
  rideId: string;
  rideCode: string;
  /** Deducted from the driver, rupees. */
  amount: number;
  refundAmount: number;
}

export interface DriverReviewedEvent {
  driverId: string;
  userId: string;
  approved: boolean;
  reason?: string;
}

/** An admin approved or rejected a change an approved driver asked for. */
export interface DriverChangeReviewedEvent {
  requestId: string;
  driverId: string;
  userId: string;
  /** "Driving licence", "Vehicle details", … */
  label: string;
  approved: boolean;
  reason?: string;
}

/** An admin suspended an approved driver, or reinstated a suspended one (Phase 7). */
export interface DriverStatusChangedEvent {
  driverId: string;
  userId: string;
  suspended: boolean;
  reason?: string;
}

export interface UserLoggedOutEvent {
  userId: string;
  deviceId?: string;
}

/**
 * Every session of a user was ended at once (password reset, "sign out
 * everywhere"). `exceptDeviceId` is the device that asked for it and keeps
 * receiving pushes when it signs straight back in.
 */
export interface UserSessionsRevokedEvent {
  userId: string;
  reason: "PASSWORD_RESET" | "SIGN_OUT_EVERYWHERE" | "ACCOUNT_DELETED";
  exceptDeviceId?: string;
}

/** Something happened inside a circuit that the customer and/or driver should be told about. */
export type CircuitNoticeKind =
  | "STOP_ARRIVED"
  | "NEXT_STOP"
  | "STOP_SKIPPED"
  | "STOP_BLOCKED"
  | "EXCEPTION_RESOLVED"
  | "TIME_30_MIN"
  | "TIME_10_MIN"
  | "TIME_EXHAUSTED"
  | "DISTANCE_80"
  | "DISTANCE_EXHAUSTED";

export interface CircuitNoticeEvent {
  ride: RideSnapshot;
  kind: CircuitNoticeKind;
  stopName?: string;
  stopOrder?: number;
  nextStopName?: string;
  remainingMinutes?: number;
}

/**
 * Every in-process domain event. Producers publish *after* MongoDB has
 * committed the change; consumers must be idempotent and must never be
 * able to fail the producer's request.
 */
export interface DomainEventMap {
  "ride.transitioned": RideTransitionedEvent;
  "ride.driver_arriving": RideDriverArrivingEvent;
  "ride.end_requested": RideEndRequestedEvent;
  "ride.payment_updated": RidePaymentUpdatedEvent;
  "circuit.notice": CircuitNoticeEvent;
  "payment.refund_updated": PaymentRefundUpdatedEvent;
  "earnings.adjusted": EarningsAdjustedEvent;
  "driver.reviewed": DriverReviewedEvent;
  "driver.status_changed": DriverStatusChangedEvent;
  "driver.change_reviewed": DriverChangeReviewedEvent;
  "auth.logged_out": UserLoggedOutEvent;
  "auth.sessions_revoked": UserSessionsRevokedEvent;
}

export type DomainEventName = keyof DomainEventMap;
export type DomainEventHandler<K extends DomainEventName> = (
  event: DomainEventMap[K],
) => Promise<void> | void;
