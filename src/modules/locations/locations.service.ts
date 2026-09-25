import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { apiBadRequest } from "../../common/exceptions/api.exception";
import type { GeoCoordinates } from "./geo";
import { haversineMeters } from "./geo";
import { ROUTE_ESTIMATOR } from "./route-estimator";
import type { RouteEstimate, RouteEstimator } from "./route-estimator";

@Injectable()
export class LocationsService {
  private readonly minDistanceMeters: number;
  private readonly maxDistanceMeters: number;

  constructor(
    @Inject(ROUTE_ESTIMATOR) private readonly estimator: RouteEstimator,
    config: ConfigService,
  ) {
    this.minDistanceMeters = config.getOrThrow<number>("rideMinDistanceMeters");
    this.maxDistanceMeters = config.getOrThrow<number>("rideMaxDistanceKm") * 1000;
  }

  /**
   * Trip distance/duration for a bookable ride. Rejects trips that are too
   * short to be a real ride (pickup == destination, GPS jitter) or beyond the
   * service's intra-city range.
   */
  async estimateTrip(pickup: GeoCoordinates, destination: GeoCoordinates): Promise<RouteEstimate> {
    // Checked on the straight line first so an obviously bad request never
    // reaches a (future, billable) maps provider.
    const straightLine = haversineMeters(pickup, destination);
    if (straightLine < this.minDistanceMeters)
      throw apiBadRequest(
        "Pickup and destination are too close together",
        "RIDE_TOO_SHORT",
        { minDistanceMeters: this.minDistanceMeters },
      );
    if (straightLine > this.maxDistanceMeters)
      throw apiBadRequest(
        "This trip is outside our service range",
        "RIDE_TOO_LONG",
        { maxDistanceMeters: this.maxDistanceMeters },
      );
    return this.estimator.estimate(pickup, destination);
  }

  /** Approximate straight-line distance, e.g. driver → pickup for a request card. */
  approximateDistanceMeters(from: GeoCoordinates, to: GeoCoordinates): number {
    return Math.round(haversineMeters(from, to));
  }
}
