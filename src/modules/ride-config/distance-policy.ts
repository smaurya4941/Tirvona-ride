import { DISTANCE_LIMITS, RADIUS_LIMITS } from "./ride-config.limits";

export interface DistanceLimits {
  minDistanceMeters: number;
  maxDistanceKm: number;
}

/** The policy a ride was accepted under; stored on the ride and never rewritten. */
export interface AppliedDistancePolicy {
  rideType: string;
  minDistanceMeters: number;
  /** Maximum in metres (the admin-facing km value × 1000), what the check compared against. */
  maxDistanceMeters: number;
  configId: string;
  configVersion: number;
}

export type DistanceViolation =
  | { code: "RIDE_TOO_SHORT"; message: string; data: { minDistanceMeters: number } }
  | { code: "RIDE_TOO_LONG"; message: string; data: { maxDistanceMeters: number } };

export const maxDistanceMeters = (limits: DistanceLimits): number => Math.round(limits.maxDistanceKm * 1000);

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** Why a pair of limits cannot be used, or null when they are sound. Shared by the admin API and the runtime guard. */
export function distanceLimitsProblem(limits: Partial<DistanceLimits>): string | null {
  const { minDistanceMeters: min, maxDistanceKm: max } = limits;
  if (!finite(min) || !finite(max)) return "Minimum and maximum distance must both be numbers";
  if (min <= 0 || max <= 0) return "Distances must be greater than zero";
  const m = DISTANCE_LIMITS.minDistanceMeters;
  const k = DISTANCE_LIMITS.maxDistanceKm;
  if (min < m.min || min > m.max) return `Minimum distance must be between ${m.min} and ${m.max} metres`;
  if (max < k.min || max > k.max) return `Maximum distance must be between ${k.min} and ${k.max} km`;
  if (min >= max * 1000) return "Minimum distance must be less than the maximum distance";
  return null;
}

export function radiiProblem(radii: { matchingRadiusKm?: unknown; nearbyDriversRadiusKm?: unknown }): string | null {
  const { matchingRadiusKm: matching, nearbyDriversRadiusKm: nearby } = radii;
  if (!finite(matching) || !finite(nearby)) return "Both radii must be numbers";
  const m = RADIUS_LIMITS.matchingRadiusKm;
  const n = RADIUS_LIMITS.nearbyDriversRadiusKm;
  if (matching < m.min || matching > m.max) return `Matching radius must be between ${m.min} and ${m.max} km`;
  if (nearby < n.min || nearby > n.max) return `Nearby drivers radius must be between ${n.min} and ${n.max} km`;
  return null;
}

/**
 * The one comparison of a trip's length against a ride type's limits. Both
 * ends are inclusive: exactly the minimum or exactly the maximum is allowed.
 */
export function checkTripDistance(limits: DistanceLimits, tripMeters: number): DistanceViolation | null {
  if (tripMeters < limits.minDistanceMeters)
    return {
      code: "RIDE_TOO_SHORT",
      message: "Pickup and destination are too close together",
      data: { minDistanceMeters: limits.minDistanceMeters },
    };
  const max = maxDistanceMeters(limits);
  if (tripMeters > max)
    return { code: "RIDE_TOO_LONG", message: "This trip is outside our service range", data: { maxDistanceMeters: max } };
  return null;
}
