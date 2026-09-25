import { DRIVER_ENGAGED_STATUSES, RideStatus } from "../rides/ride-state-machine";

/** Public status vocabulary — never the internal state names. */
export type SharedRideStatus =
  | "REQUESTED"
  | "DRIVER_ASSIGNED"
  | "DRIVER_ARRIVING"
  | "DRIVER_ARRIVED"
  | "RIDE_IN_PROGRESS"
  | "COMPLETED"
  | "CANCELLED";

/**
 * Everything the public share page may show. Deliberately absent: the
 * customer (name, phone, email), the driver's phone and surname, the ride
 * id, fares and payment, OTPs, and any internal id.
 */
export interface SharedRideView {
  status: SharedRideStatus;
  statusLabel: string;
  statusMessage: string;
  /** False once the ride is over — the page stops refreshing. */
  isLive: boolean;
  rideType: string;
  driver: { firstName: string; ratingAverage?: number } | null;
  vehicle: { type: string; registrationNumber: string; description?: string } | null;
  pickup: { address: string; latitude: number; longitude: number };
  destination: { address: string; latitude: number; longitude: number };
  driverLocation: { latitude: number; longitude: number; updatedAt: Date } | null;
  startedAt?: Date;
  completedAt?: Date;
  cancelledAt?: Date;
  lastUpdatedAt: Date;
  expiresAt: Date;
}

export function publicRideStatus(status: RideStatus): SharedRideStatus {
  switch (status) {
    case RideStatus.SEARCHING:
      return "REQUESTED";
    case RideStatus.DRIVER_ASSIGNED:
      return "DRIVER_ASSIGNED";
    case RideStatus.DRIVER_ACCEPTED:
      return "DRIVER_ARRIVING";
    case RideStatus.DRIVER_ARRIVED:
      return "DRIVER_ARRIVED";
    case RideStatus.RIDE_STARTED:
      return "RIDE_IN_PROGRESS";
    case RideStatus.COMPLETED:
      return "COMPLETED";
    case RideStatus.CANCELLED:
    case RideStatus.NO_DRIVER_AVAILABLE:
      return "CANCELLED";
  }
}

export const SHARED_STATUS_TEXT: Record<SharedRideStatus, { label: string; message: string }> = {
  REQUESTED: { label: "Finding a driver", message: "The ride has been requested and a driver is being matched." },
  DRIVER_ASSIGNED: { label: "Driver assigned", message: "A driver has been assigned and is confirming the ride." },
  DRIVER_ARRIVING: { label: "Driver is on the way", message: "The driver is heading to the pickup point." },
  DRIVER_ARRIVED: { label: "Driver has arrived", message: "The driver is waiting at the pickup point." },
  RIDE_IN_PROGRESS: { label: "Ride in progress", message: "The trip is under way." },
  COMPLETED: { label: "Ride completed", message: "The rider has reached the destination." },
  CANCELLED: { label: "Ride cancelled", message: "This ride did not go ahead." },
};

/** Driver position is shared only while the driver is committed to the ride. */
export const sharesDriverLocation = (status: RideStatus): boolean => DRIVER_ENGAGED_STATUSES.includes(status);

/**
 * When a link stops working: its own expiry, or the ride's end plus the
 * grace period, whichever comes first. Pure (unit-tested).
 */
export function effectiveShareExpiry(expiresAt: Date, rideEndedAt: Date | undefined, graceMinutes: number): Date {
  if (!rideEndedAt) return expiresAt;
  const graceEnd = new Date(rideEndedAt.getTime() + graceMinutes * 60_000);
  return graceEnd < expiresAt ? graceEnd : expiresAt;
}
