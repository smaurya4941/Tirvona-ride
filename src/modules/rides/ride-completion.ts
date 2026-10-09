import { haversineMeters } from "../locations/geo";
import type { GeoCoordinates } from "../locations/geo";

/** How a trip was ended. Stored on the ride and shown to the safety/ops team. */
export enum RideCompletionMode {
  /** The rider read the end-of-trip OTP to the driver. */
  OTP = "OTP",
  /**
   * The rider could not or would not give the code; the driver ended the trip
   * after the wait. Always flagged for review.
   */
  DRIVER_OVERRIDE = "DRIVER_OVERRIDE",
  /** Ended by the safety/ops team from the admin panel. */
  ADMIN = "ADMIN",
  /** An SOS was open on the ride, so no code was asked for. */
  SOS = "SOS",
  /** RIDE_END_OTP_ENFORCED=false: an older app completed without a code. */
  NOT_REQUIRED = "NOT_REQUIRED",
}

/** Modes the support team should look at (everything but a normal OTP end). */
export const REVIEW_COMPLETION_MODES: readonly RideCompletionMode[] = [
  RideCompletionMode.DRIVER_OVERRIDE,
  RideCompletionMode.ADMIN,
  RideCompletionMode.SOS,
];

/** Where the driver was, relative to the booked drop-off, when the trip end was requested. */
export interface RideEndCheckInput {
  location?: GeoCoordinates & { updatedAt?: Date };
  destination: GeoCoordinates;
  farRadiusMeters: number;
}

export interface RideEndCheckResult {
  /** Absent when the driver's position was not known. */
  distanceToDestinationMeters?: number;
  /**
   * True when the driver ended the trip further than the radius from the
   * booked drop-off. An unknown position is NOT flagged: a phone with no GPS
   * is not evidence of anything.
   */
  farFromDestination: boolean;
  /** When that position was recorded. */
  locationAt?: Date;
}

export function evaluateEndLocation(
  input: RideEndCheckInput,
): RideEndCheckResult {
  if (!input.location) return { farFromDestination: false };
  const distance = Math.round(
    haversineMeters(input.location, input.destination),
  );
  return {
    distanceToDestinationMeters: distance,
    farFromDestination: distance > input.farRadiusMeters,
    locationAt: input.location.updatedAt,
  };
}

/** When the "rider is not responding" fallback unlocks for the driver. */
export const overrideAvailableAt = (
  endRequestedAt: Date,
  waitSeconds: number,
): Date => new Date(endRequestedAt.getTime() + waitSeconds * 1000);
