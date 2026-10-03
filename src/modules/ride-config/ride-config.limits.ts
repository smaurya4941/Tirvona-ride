/**
 * Sanity rails for what an admin may enter (a fat-fingered extra zero), plus
 * the values the first-boot migration writes. The migration values are what
 * the old RIDE_*_DISTANCE_* / MATCHING_RADIUS_KM / NEARBY_DRIVERS_RADIUS_KM
 * defaults were, so upgrading changes no behaviour; they are written once,
 * never read at runtime, and never used as a fallback.
 */
export const DISTANCE_LIMITS = {
  minDistanceMeters: { min: 1, max: 50_000 },
  maxDistanceKm: { min: 0.1, max: 1_000 },
} as const;

export const RADIUS_LIMITS = {
  matchingRadiusKm: { min: 0.5, max: 100 },
  nearbyDriversRadiusKm: { min: 0.1, max: 50 },
} as const;

export const MIGRATION_DEFAULTS = {
  minDistanceMeters: 200,
  maxDistanceKm: 80,
  matchingRadiusKm: 8,
  nearbyDriversRadiusKm: 3,
} as const;
