/** Which kind of trip a `rides` document is. Everything that exists for a normal ride also exists for a circuit. */
export enum RideKind {
  NORMAL = "NORMAL",
  CIRCUIT = "CIRCUIT",
}

/**
 * Per-stop lifecycle, owned by the backend:
 *   UPCOMING → ARRIVING (the active stop) → ARRIVED → WAITING (customer visiting) → COMPLETED
 * A stop Admin resolves as unreachable becomes SKIPPED instead.
 */
export enum CircuitStopStatus {
  UPCOMING = "UPCOMING",
  ARRIVING = "ARRIVING",
  ARRIVED = "ARRIVED",
  WAITING = "WAITING",
  COMPLETED = "COMPLETED",
  SKIPPED = "SKIPPED",
}

/** Operational exceptions a driver can raise; only Admin resolves them. */
export enum CircuitExceptionType {
  STOP_BLOCKED = "STOP_BLOCKED",
}

export enum CircuitExceptionResolution {
  /** The stop is reachable again; the driver carries on. */
  CONTINUE = "CONTINUE",
  /** Drop the stop and move to the next one. */
  SKIP_STOP = "SKIP_STOP",
}

/** Realtime events specific to circuits, on top of the normal ride events. */
export const CircuitEvent = {
  STARTED: "circuit.started",
  STOP_ARRIVED: "circuit.stop.arrived",
  STOP_WAITING: "circuit.stop.waiting",
  STOP_COMPLETED: "circuit.stop.completed",
  STOP_SKIPPED: "circuit.stop.skipped",
  STOP_BLOCKED: "circuit.stop.blocked",
  EXCEPTION_RESOLVED: "circuit.exception.resolved",
  NEXT_STOP: "circuit.next_stop",
  /** Periodic: distance used so far (the server clock drives the timer; apps count locally between these). */
  USAGE: "circuit.usage",
  TIME_WARNING: "circuit.time_warning",
  DISTANCE_WARNING: "circuit.distance_warning",
  COMPLETED: "circuit.completed",
} as const;
export type CircuitEventName = (typeof CircuitEvent)[keyof typeof CircuitEvent];

export const CIRCUIT_STOP_DONE: readonly CircuitStopStatus[] = [
  CircuitStopStatus.COMPLETED,
  CircuitStopStatus.SKIPPED,
];

export const isStopDone = (status: CircuitStopStatus): boolean =>
  CIRCUIT_STOP_DONE.includes(status);

export interface StopLike {
  order: number;
  status: CircuitStopStatus;
}

/** The stop the driver is working on: the first one not done. Undefined once every stop is done. */
export function activeStop<T extends StopLike>(
  stops: readonly T[],
): T | undefined {
  return [...stops]
    .sort((a, b) => a.order - b.order)
    .find((stop) => !isStopDone(stop.status));
}

export const allStopsDone = (stops: readonly StopLike[]): boolean =>
  stops.length > 0 && stops.every((stop) => isStopDone(stop.status));

/** The stop status a command may start from, and where it leads. */
export const STOP_COMMANDS = {
  ARRIVE: { from: [CircuitStopStatus.ARRIVING], to: CircuitStopStatus.ARRIVED },
  WAIT: { from: [CircuitStopStatus.ARRIVED], to: CircuitStopStatus.WAITING },
  COMPLETE: {
    from: [CircuitStopStatus.ARRIVED, CircuitStopStatus.WAITING],
    to: CircuitStopStatus.COMPLETED,
  },
} as const;
export type StopCommand = keyof typeof STOP_COMMANDS;
