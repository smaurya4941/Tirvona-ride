import { calculateCircuitFare } from "./circuit-pricing";
import type { CircuitFareBreakdown } from "./circuit-pricing";
import { activeStop } from "./circuit-ride.types";
import type {
  CircuitExceptionType,
  CircuitStopStatus,
} from "./circuit-ride.types";
import type { RideCircuit } from "./schemas/ride-circuit.schema";

export interface CircuitStopView {
  order: number;
  placeId: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  status: CircuitStopStatus;
  arrivedAt?: Date;
  waitingAt?: Date;
  completedAt?: Date;
  skippedAt?: Date;
}

/** What apps render for a circuit ride. Everything here is computed by the server; apps never derive it. */
export interface CircuitView {
  packageId: string;
  packageCode: string;
  name: string;
  city: string;
  passengers: number;
  stops: CircuitStopView[];
  /** The stop being worked on; absent before the start and once every stop is done. */
  currentStop?: CircuitStopView;
  currentStopOrder: number;
  /** Every stop is done: the driver can complete the circuit. */
  readyToComplete: boolean;
  pricing: {
    basePrice: number;
    includedDistanceMeters: number;
    includedDurationSeconds: number;
    extraDistanceRatePerKm: number;
    extraDurationRatePerHour: number;
  };
  usage: {
    /** Distance travelled since the start (GPS trail), metres. */
    distanceMeters: number;
    distanceReliable: boolean;
    /** Seconds since RIDE_STARTED (frozen at completion). 0 before the start. */
    elapsedSeconds: number;
    /** Included time left; negative once exceeded. */
    remainingSeconds: number;
    remainingDistanceMeters: number;
    /** Server clock when the view was built, so a client can correct its own clock. */
    serverTime: Date;
  };
  /** What the circuit would cost if it ended now (package + extras so far). */
  projected: CircuitFareBreakdown;
  /** How the final fare was reached; present once the circuit is completed. */
  settlement?: {
    usedDistanceMeters: number;
    usedDurationSeconds: number;
    distanceSource: string;
    extraKm: number;
    extraBlocks: number;
    completedBy: string;
  };
  exception?: {
    type: CircuitExceptionType;
    stopOrder: number;
    note?: string;
    reportedAt: Date;
  };
  cancellationPolicy?: string;
  endedEarlyReason?: string;
}

const stopView = (stop: RideCircuit["stops"][number]): CircuitStopView => ({
  order: stop.order,
  placeId: stop.placeId,
  name: stop.name,
  address: stop.address,
  latitude: stop.latitude,
  longitude: stop.longitude,
  status: stop.status,
  arrivedAt: stop.arrivedAt,
  waitingAt: stop.waitingAt,
  completedAt: stop.completedAt,
  skippedAt: stop.skippedAt,
});

/** Seconds the circuit has run: from RIDE_STARTED to now, or to completion. */
export function elapsedSeconds(
  startedAt: Date | undefined,
  completedAt: Date | undefined,
  now: Date,
): number {
  if (!startedAt) return 0;
  const end = completedAt ?? now;
  return Math.max(0, Math.round((end.getTime() - startedAt.getTime()) / 1000));
}

export function circuitView(
  circuit: RideCircuit,
  ride: { startedAt?: Date; completedAt?: Date },
  now: Date = new Date(),
): CircuitView {
  const stops = [...circuit.stops]
    .sort((a, b) => a.order - b.order)
    .map(stopView);
  const elapsed = elapsedSeconds(ride.startedAt, ride.completedAt, now);
  const distance = circuit.usage?.distanceMeters ?? 0;
  const current =
    ride.startedAt && !ride.completedAt ? activeStop(stops) : undefined;
  return {
    packageId: circuit.packageId.toString(),
    packageCode: circuit.packageCode,
    name: circuit.name,
    city: circuit.city,
    passengers: circuit.passengers,
    stops,
    currentStop: current,
    currentStopOrder: circuit.currentStopOrder,
    readyToComplete:
      stops.length > 0 && circuit.currentStopOrder > stops.length,
    pricing: {
      basePrice: circuit.pricing.basePrice,
      includedDistanceMeters: circuit.pricing.includedDistanceMeters,
      includedDurationSeconds: circuit.pricing.includedDurationSeconds,
      extraDistanceRatePerKm: circuit.pricing.extraDistanceRatePerKm,
      extraDurationRatePerHour: circuit.pricing.extraDurationRatePerHour,
    },
    usage: {
      distanceMeters: distance,
      distanceReliable: circuit.usage?.reliable ?? true,
      elapsedSeconds: elapsed,
      remainingSeconds: circuit.pricing.includedDurationSeconds - elapsed,
      remainingDistanceMeters:
        circuit.pricing.includedDistanceMeters - distance,
      serverTime: now,
    },
    projected: calculateCircuitFare(circuit.pricing, distance, elapsed),
    settlement: circuit.settlement
      ? {
          usedDistanceMeters: circuit.settlement.usedDistanceMeters,
          usedDurationSeconds: circuit.settlement.usedDurationSeconds,
          distanceSource: circuit.settlement.distanceSource,
          extraKm: circuit.settlement.extraKm,
          extraBlocks: circuit.settlement.extraBlocks,
          completedBy: circuit.settlement.completedBy,
        }
      : undefined,
    exception: circuit.exception
      ? {
          type: circuit.exception.type,
          stopOrder: circuit.exception.stopOrder,
          note: circuit.exception.note,
          reportedAt: circuit.exception.reportedAt,
        }
      : undefined,
    cancellationPolicy: circuit.cancellationPolicy,
    endedEarlyReason: circuit.endedEarlyReason,
  };
}
