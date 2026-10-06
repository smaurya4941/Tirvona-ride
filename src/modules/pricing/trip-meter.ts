import type { FinalFareMode } from "../../config/environment";
import { calculateFare } from "./fare-calculator";
import type { FareBreakdown, PricingRates } from "./fare-calculator";

/** One position on the trip trail (the ride's location checkpoints). */
export interface TrailPoint {
  latitude: number;
  longitude: number;
  recordedAt: Date;
}

export interface TripMeasurement {
  /** Sum of the trail's legs, glitches removed. */
  distanceMeters: number;
  points: number;
  /** Longest time between two consecutive fixes. */
  maxGapSeconds: number;
  /** Whether the trail is dense and clean enough to bill on. */
  reliable: boolean;
  /** Why the trail was not trusted (when `reliable` is false). */
  reason?: "TOO_FEW_POINTS" | "GAP_TOO_LONG" | "GLITCHY";
}

/** Faster than any auto or cab in town: a leg implying this is a GPS jump. */
const MAX_PLAUSIBLE_SPEED_MPS = 45;
const EARTH_RADIUS_METERS = 6_371_008.8;

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

function haversine(a: TrailPoint, b: TrailPoint): number {
  const dLat = toRadians(b.latitude - a.latitude);
  const dLon = toRadians(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(a.latitude)) *
      Math.cos(toRadians(b.latitude)) *
      Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Distance travelled along a trip trail (STARTED → TRIP samples → COMPLETED).
 *
 * The trail is sampled every RIDE_CHECKPOINT_INTERVAL_SECONDS, so each leg is
 * a straight chord of the road; at 15 s that is well within a few percent in
 * town. A leg that implies an impossible speed is a GPS jump and is skipped
 * (the next fix is measured from the last good one). A trail with a long gap
 * (GPS off, app killed) under-measures, so it is flagged unreliable and the
 * caller falls back to the booked distance.
 */
export function measureTrip(
  points: TrailPoint[],
  maxGapSeconds: number,
): TripMeasurement {
  const ordered = [...points].sort(
    (a, b) => a.recordedAt.getTime() - b.recordedAt.getTime(),
  );
  if (ordered.length < 2)
    return {
      distanceMeters: 0,
      points: ordered.length,
      maxGapSeconds: 0,
      reliable: false,
      reason: "TOO_FEW_POINTS",
    };

  let distance = 0;
  let longestGap = 0;
  let glitches = 0;
  let previous = ordered[0];
  for (const point of ordered.slice(1)) {
    const seconds =
      (point.recordedAt.getTime() - previous.recordedAt.getTime()) / 1000;
    longestGap = Math.max(longestGap, seconds);
    const leg = haversine(previous, point);
    if (seconds > 0 && leg / seconds > MAX_PLAUSIBLE_SPEED_MPS) {
      glitches += 1;
      continue;
    }
    distance += leg;
    previous = point;
  }

  const measurement = {
    distanceMeters: Math.round(distance),
    points: ordered.length,
    maxGapSeconds: Math.round(longestGap),
  };
  if (longestGap > maxGapSeconds)
    return { ...measurement, reliable: false, reason: "GAP_TOO_LONG" };
  // More than a quarter of the legs jumping: the device's GPS is not usable.
  if (glitches * 4 > ordered.length - 1)
    return { ...measurement, reliable: false, reason: "GLITCHY" };
  return { ...measurement, reliable: true };
}

export type TripSource = "ACTUAL" | "BOOKED";

export interface FinalFareInput {
  mode: FinalFareMode;
  rates: PricingRates;
  bookedDistanceMeters: number;
  bookedDurationSeconds: number;
  estimatedFare: number;
  startedAt?: Date;
  completedAt: Date;
  measurement?: TripMeasurement;
  /** Final fare ≤ estimate × this; 0 = no cap. */
  maxEstimateMultiplier: number;
}

export interface FinalFareResult {
  breakdown: FareBreakdown;
  distanceMeters: number;
  durationSeconds: number;
  distanceSource: TripSource;
  durationSource: TripSource;
  /** The trail distance, even when it was not billed (support/disputes). */
  measuredDistanceMeters?: number;
  capApplied: boolean;
  /** What the fare would have been without the cap. */
  uncappedFare?: number;
  total: number;
}

/**
 * Ride completed → final fare, from the tariff frozen on the ride at booking
 * (never today's tariff), the actual trip, and customer-protection rules:
 *
 * - duration: the server's own start/complete timestamps;
 * - distance: the GPS trail when reliable, else the booked route;
 * - cap: never more than `maxEstimateMultiplier` × the estimate the customer
 *   accepted (a detour or a GPS fault must not produce a shock bill).
 *
 * In `booked` mode the booked route's distance and time are billed, exactly
 * as the estimate was.
 */
export function resolveFinalFare(input: FinalFareInput): FinalFareResult {
  const actual = input.mode === "actual";
  const durationSource: TripSource =
    actual && input.startedAt ? "ACTUAL" : "BOOKED";
  const durationSeconds =
    durationSource === "ACTUAL"
      ? Math.max(
          0,
          Math.round(
            (input.completedAt.getTime() - input.startedAt!.getTime()) / 1000,
          ),
        )
      : input.bookedDurationSeconds;
  const distanceSource: TripSource =
    actual && input.measurement?.reliable ? "ACTUAL" : "BOOKED";
  const distanceMeters =
    distanceSource === "ACTUAL"
      ? input.measurement!.distanceMeters
      : input.bookedDistanceMeters;

  const breakdown = calculateFare(input.rates, distanceMeters, durationSeconds);
  const cap =
    input.maxEstimateMultiplier > 0
      ? Math.round(input.estimatedFare * input.maxEstimateMultiplier)
      : Infinity;
  const capApplied = breakdown.total > cap;
  return {
    breakdown,
    distanceMeters,
    durationSeconds,
    distanceSource,
    durationSource,
    measuredDistanceMeters: input.measurement?.distanceMeters,
    capApplied,
    uncappedFare: capApplied ? breakdown.total : undefined,
    total: capApplied ? cap : breakdown.total,
  };
}
