/** Socket.IO namespace for the customer and driver apps. */
export const REALTIME_NAMESPACE = "/realtime";

export const rideRoom = (rideId: string): string => `ride:${rideId}`;
export const userRoom = (userId: string): string => `user:${userId}`;

/**
 * Server → client events. Every ride event means "the backend has already
 * committed this change" — clients never originate them.
 */
export const RideEvent = {
  /** Customer: booking accepted, searching. Driver (user room): a new offer. */
  REQUESTED: "ride.requested",
  DRIVER_ASSIGNED: "ride.driver_assigned",
  /** The assigned driver rejected / timed out / went offline; searching again. */
  SEARCHING: "ride.searching",
  /** Driver (user room): the offer they were shown is no longer theirs. */
  OFFER_WITHDRAWN: "ride.offer_withdrawn",
  DRIVER_ACCEPTED: "ride.driver_accepted",
  /** The accepted driver came within DRIVER_ARRIVING_RADIUS_METERS. Once. */
  DRIVER_ARRIVING: "ride.driver_arriving",
  DRIVER_ARRIVED: "ride.driver_arrived",
  /** Customer: the start-of-trip OTP was rotated (expiry / lockout). */
  OTP_REFRESHED: "ride.otp_refreshed",
  STARTED: "ride.started",
  /** High frequency, volatile (dropped rather than queued when a client lags). */
  LOCATION_UPDATED: "ride.location_updated",
  COMPLETED: "ride.completed",
  CANCELLED: "ride.cancelled",
  NO_DRIVER_AVAILABLE: "ride.no_driver_available",
  /**
   * The ride's payment status changed (order created, failed, verified,
   * refunded). Sent to the customer and the driver on their user rooms —
   * the ride room is already closed once the ride is COMPLETED.
   */
  PAYMENT_UPDATED: "ride.payment_updated",
} as const;
export type RideEventName = (typeof RideEvent)[keyof typeof RideEvent];

/** Server → client, on the user room: keeps the notification badge live. */
export const NotificationEvent = {
  /** A new in-app notification; payload `{ notification, unreadCount }`. */
  CREATED: "notification.created",
  /** Read state changed on another device; payload `{ unreadCount }`. */
  UNREAD_COUNT: "notification.unread_count",
} as const;

/** Connection-level server → client events. */
export const SessionEvent = {
  /** Sent after every (re)connect, with the ride rooms the server restored. */
  READY: "session.ready",
  /** The access token behind this socket expired; refresh and reconnect. */
  EXPIRED: "session.expired",
} as const;

/** Client → server messages. All reply through a Socket.IO acknowledgement. */
export const ClientMessage = {
  JOIN_RIDE: "ride.join",
  LEAVE_RIDE: "ride.leave",
  DRIVER_LOCATION: "driver.location",
} as const;

/** Machine-readable codes in failed acks and connect errors. */
export const RealtimeErrorCode = {
  AUTH_UNAUTHORIZED: "AUTH_UNAUTHORIZED",
  AUTH_TOKEN_EXPIRED: "AUTH_TOKEN_EXPIRED",
  AUTH_FORBIDDEN: "AUTH_FORBIDDEN",
  USER_BLOCKED: "USER_BLOCKED",
  VALIDATION_FAILED: "VALIDATION_FAILED",
  RATE_LIMITED: "RATE_LIMITED",
  RIDE_NOT_FOUND: "RIDE_NOT_FOUND",
  RIDE_NOT_ACTIVE: "RIDE_NOT_ACTIVE",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;
