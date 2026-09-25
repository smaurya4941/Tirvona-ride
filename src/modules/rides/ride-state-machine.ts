export enum RideStatus {
  SEARCHING = "SEARCHING",
  DRIVER_ASSIGNED = "DRIVER_ASSIGNED",
  DRIVER_ACCEPTED = "DRIVER_ACCEPTED",
  DRIVER_ARRIVED = "DRIVER_ARRIVED",
  RIDE_STARTED = "RIDE_STARTED",
  COMPLETED = "COMPLETED",
  CANCELLED = "CANCELLED",
  /** Search window elapsed with nobody matched — terminal, customer rebooks. */
  NO_DRIVER_AVAILABLE = "NO_DRIVER_AVAILABLE",
}

export enum RideActorType {
  CUSTOMER = "CUSTOMER",
  DRIVER = "DRIVER",
  ADMIN = "ADMIN",
  SYSTEM = "SYSTEM",
}

/**
 * The only legal edges of the ride lifecycle. Every status write in the
 * codebase goes through RideTransitionService, which checks this table AND
 * makes the write conditional on the current status, so an illegal jump
 * (SEARCHING → COMPLETED, CANCELLED → DRIVER_ACCEPTED, …) is impossible even
 * under concurrent requests.
 */
export const RIDE_TRANSITIONS: Readonly<Record<RideStatus, readonly RideStatus[]>> = {
  [RideStatus.SEARCHING]: [
    RideStatus.DRIVER_ASSIGNED,
    RideStatus.CANCELLED,
    RideStatus.NO_DRIVER_AVAILABLE,
  ],
  [RideStatus.DRIVER_ASSIGNED]: [
    RideStatus.DRIVER_ACCEPTED,
    // Driver rejected, timed out, or went offline → re-match.
    RideStatus.SEARCHING,
    RideStatus.CANCELLED,
  ],
  [RideStatus.DRIVER_ACCEPTED]: [RideStatus.DRIVER_ARRIVED, RideStatus.CANCELLED],
  [RideStatus.DRIVER_ARRIVED]: [RideStatus.RIDE_STARTED, RideStatus.CANCELLED],
  [RideStatus.RIDE_STARTED]: [RideStatus.COMPLETED],
  [RideStatus.COMPLETED]: [],
  [RideStatus.CANCELLED]: [],
  [RideStatus.NO_DRIVER_AVAILABLE]: [],
};

export const TERMINAL_RIDE_STATUSES: readonly RideStatus[] = [
  RideStatus.COMPLETED,
  RideStatus.CANCELLED,
  RideStatus.NO_DRIVER_AVAILABLE,
];

export const ACTIVE_RIDE_STATUSES: readonly RideStatus[] = Object.values(RideStatus).filter(
  (status) => !TERMINAL_RIDE_STATUSES.includes(status),
);

/** Statuses in which the driver is committed to the ride (post-accept). */
export const DRIVER_ENGAGED_STATUSES: readonly RideStatus[] = [
  RideStatus.DRIVER_ACCEPTED,
  RideStatus.DRIVER_ARRIVED,
  RideStatus.RIDE_STARTED,
];

// Once the trip is under way it can only be completed; cancellation fees and
// mid-trip disputes are Phase 7.
export const CUSTOMER_CANCELLABLE_STATUSES: readonly RideStatus[] = [
  RideStatus.SEARCHING,
  RideStatus.DRIVER_ASSIGNED,
  RideStatus.DRIVER_ACCEPTED,
  RideStatus.DRIVER_ARRIVED,
];

// Before accepting, a driver rejects instead of cancelling.
export const DRIVER_CANCELLABLE_STATUSES: readonly RideStatus[] = [
  RideStatus.DRIVER_ACCEPTED,
  RideStatus.DRIVER_ARRIVED,
];

export const isTerminal = (status: RideStatus): boolean =>
  TERMINAL_RIDE_STATUSES.includes(status);

export const canTransition = (from: RideStatus, to: RideStatus): boolean =>
  RIDE_TRANSITIONS[from].includes(to);

export class IllegalRideTransitionError extends Error {
  constructor(
    readonly from: RideStatus,
    readonly to: RideStatus,
  ) {
    super(`Illegal ride transition ${from} → ${to}`);
    this.name = "IllegalRideTransitionError";
  }
}

export function assertTransition(from: RideStatus, to: RideStatus): void {
  if (!canTransition(from, to)) throw new IllegalRideTransitionError(from, to);
}
