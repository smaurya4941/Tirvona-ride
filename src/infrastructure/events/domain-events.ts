import type { RidePaymentStatus } from "../../modules/rides/ride-payment-status";
import type { RideActorType, RideStatus } from "../../modules/rides/ride-state-machine";

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

export interface RidePaymentUpdatedEvent {
  ride: RideSnapshot;
  paymentStatus: RidePaymentStatus;
  amount?: number;
}

export interface DriverReviewedEvent {
  driverId: string;
  userId: string;
  approved: boolean;
  reason?: string;
}

export interface UserLoggedOutEvent {
  userId: string;
  deviceId?: string;
}

/**
 * Every in-process domain event. Producers publish *after* MongoDB has
 * committed the change; consumers must be idempotent and must never be
 * able to fail the producer's request.
 */
export interface DomainEventMap {
  "ride.transitioned": RideTransitionedEvent;
  "ride.driver_arriving": RideDriverArrivingEvent;
  "ride.payment_updated": RidePaymentUpdatedEvent;
  "driver.reviewed": DriverReviewedEvent;
  "auth.logged_out": UserLoggedOutEvent;
}

export type DomainEventName = keyof DomainEventMap;
export type DomainEventHandler<K extends DomainEventName> = (event: DomainEventMap[K]) => Promise<void> | void;
