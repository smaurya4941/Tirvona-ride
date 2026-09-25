import { RideStatus } from "../rides/ride-state-machine";

export enum SosStatus {
  TRIGGERED = "TRIGGERED",
  ACKNOWLEDGED = "ACKNOWLEDGED",
  IN_PROGRESS = "IN_PROGRESS",
  RESOLVED = "RESOLVED",
  /** Closed by the safety team as a false alarm. */
  CANCELLED = "CANCELLED",
}

export const OPEN_SOS_STATUSES: readonly SosStatus[] = [
  SosStatus.TRIGGERED,
  SosStatus.ACKNOWLEDGED,
  SosStatus.IN_PROGRESS,
];

/**
 * Admin-driven incident lifecycle. Steps may be skipped forward (a call
 * that settles everything can go TRIGGERED → RESOLVED) but never backward,
 * and a closed incident stays closed — history is retained as-is.
 */
export const SOS_TRANSITIONS: Readonly<Record<SosStatus, readonly SosStatus[]>> = {
  [SosStatus.TRIGGERED]: [SosStatus.ACKNOWLEDGED, SosStatus.IN_PROGRESS, SosStatus.RESOLVED, SosStatus.CANCELLED],
  [SosStatus.ACKNOWLEDGED]: [SosStatus.IN_PROGRESS, SosStatus.RESOLVED, SosStatus.CANCELLED],
  [SosStatus.IN_PROGRESS]: [SosStatus.RESOLVED, SosStatus.CANCELLED],
  [SosStatus.RESOLVED]: [],
  [SosStatus.CANCELLED]: [],
};

export const canTransitionSos = (from: SosStatus, to: SosStatus): boolean => SOS_TRANSITIONS[from].includes(to);

export enum SosLocationSource {
  /** GPS fix sent by the phone that raised the alert. */
  DEVICE = "DEVICE",
  /** The driver's last known position (the phone could not get a fix). */
  DRIVER_LAST_KNOWN = "DRIVER_LAST_KNOWN",
  /** Nothing better was available. */
  RIDE_PICKUP = "RIDE_PICKUP",
}

export type SosRole = "CUSTOMER" | "DRIVER";

/**
 * Whether a participant may raise SOS on a ride in this state.
 * - Customer: from the moment a driver is assigned until the ride ends.
 * - Driver: once they have accepted (a mere offer is not "their" ride yet).
 * - Both: for a short grace period after the ride ends (incidents at drop-off).
 */
export function sosAllowed(
  role: SosRole,
  ride: { status: RideStatus; completedAt?: Date; cancelledAt?: Date },
  graceMinutes: number,
  now: Date = new Date(),
): boolean {
  switch (ride.status) {
    case RideStatus.DRIVER_ASSIGNED:
      return role === "CUSTOMER";
    case RideStatus.DRIVER_ACCEPTED:
    case RideStatus.DRIVER_ARRIVED:
    case RideStatus.RIDE_STARTED:
      return true;
    case RideStatus.COMPLETED:
    case RideStatus.CANCELLED: {
      const endedAt = ride.completedAt ?? ride.cancelledAt;
      return Boolean(endedAt) && now.getTime() - endedAt!.getTime() <= graceMinutes * 60_000;
    }
    default:
      return false;
  }
}
