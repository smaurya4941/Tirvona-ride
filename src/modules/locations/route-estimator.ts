import type { GeoCoordinates } from "./geo";

/**
 * Who computed a route. HAVERSINE is the straight-line fallback; rides store
 * this so support and reports can tell a road-routed fare from an estimate.
 */
export type RouteProvider = "HAVERSINE" | "GOOGLE_ROUTES";

export interface RouteEstimate {
  distanceMeters: number;
  durationSeconds: number;
  provider: RouteProvider;
  /**
   * The road path in Google's encoded polyline format (precision 5), for
   * drawing on a map. Absent for straight-line estimates — clients then draw
   * a straight line between the two ends.
   */
  polyline?: string;
}

/**
 * The seam between ride logic and whichever maps provider computes trips.
 * LocationsModule binds a {@link ResilientRouteEstimator} (Google Routes with
 * a straight-line fallback) or plain {@link HaversineRouteEstimator}; rides
 * and pricing only ever depend on this interface.
 */
export interface RouteEstimator {
  estimate(
    origin: GeoCoordinates,
    destination: GeoCoordinates,
  ): Promise<RouteEstimate>;
}

export const ROUTE_ESTIMATOR = Symbol("ROUTE_ESTIMATOR");

/** A routing provider could not answer; `retryable` = transient (timeout, 5xx, 429). */
export class RouteProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "RouteProviderError";
  }
}

/** The provider answered, but there is no drivable route between the points. */
export class NoRouteFoundError extends RouteProviderError {
  constructor() {
    super("No drivable route between these points", false);
    this.name = "NoRouteFoundError";
  }
}
