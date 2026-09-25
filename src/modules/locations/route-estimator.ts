import type { GeoCoordinates } from "./geo";

export type RouteProvider = "HAVERSINE";

export interface RouteEstimate {
  distanceMeters: number;
  durationSeconds: number;
  provider: RouteProvider;
}

/**
 * The seam between ride logic and whichever maps provider computes trips.
 * Phase 2 binds {@link HaversineRouteEstimator}; swapping in a road-routing
 * provider later means binding a new implementation to this token in
 * LocationsModule — rides and pricing only ever depend on the interface.
 */
export interface RouteEstimator {
  estimate(origin: GeoCoordinates, destination: GeoCoordinates): Promise<RouteEstimate>;
}

export const ROUTE_ESTIMATOR = Symbol("ROUTE_ESTIMATOR");
