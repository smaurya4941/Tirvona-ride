import { Inject, Injectable } from "@nestjs/common";
import type { GeoCoordinates } from "./geo";
import { haversineMeters } from "./geo";
import { ROUTE_ESTIMATOR } from "./route-estimator";
import type { RouteEstimate, RouteEstimator } from "./route-estimator";

@Injectable()
export class LocationsService {
  constructor(
    @Inject(ROUTE_ESTIMATOR) private readonly estimator: RouteEstimator,
  ) {}

  /**
   * Road route between two points through the shared provider, cache and
   * fallback. It knows nothing about trip-distance limits: those are judged
   * per ride type by TripPolicyService (the only path for estimates and
   * bookings). Driver → pickup / destination legs call this directly.
   */
  routeBetween(
    origin: GeoCoordinates,
    destination: GeoCoordinates,
  ): Promise<RouteEstimate> {
    return this.estimator.estimate(origin, destination);
  }

  /** Approximate straight-line distance, e.g. driver → pickup for a request card. */
  approximateDistanceMeters(from: GeoCoordinates, to: GeoCoordinates): number {
    return Math.round(haversineMeters(from, to));
  }
}
