import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { haversineMeters } from "./geo";
import type { GeoCoordinates } from "./geo";
import type { RouteEstimate, RouteEstimator } from "./route-estimator";

/** Shortest duration ever quoted, so a very short hop never shows "0 min". */
const MIN_DURATION_SECONDS = 60;

/**
 * Straight-line distance, optionally scaled by a detour factor, with duration
 * derived from an assumed average city speed. Good enough to price and test
 * the full ride lifecycle; it is NOT a live ETA and must not be shown as one.
 */
@Injectable()
export class HaversineRouteEstimator implements RouteEstimator {
  private readonly averageSpeedMetersPerSecond: number;
  private readonly distanceFactor: number;

  constructor(config: ConfigService) {
    this.averageSpeedMetersPerSecond =
      (config.getOrThrow<number>("routeAverageSpeedKmph") * 1000) / 3600;
    this.distanceFactor = config.getOrThrow<number>("routeDistanceFactor");
  }

  estimate(origin: GeoCoordinates, destination: GeoCoordinates): Promise<RouteEstimate> {
    const distanceMeters = Math.round(
      haversineMeters(origin, destination) * this.distanceFactor,
    );
    const durationSeconds = Math.max(
      MIN_DURATION_SECONDS,
      Math.round(distanceMeters / this.averageSpeedMetersPerSecond),
    );
    return Promise.resolve({ distanceMeters, durationSeconds, provider: "HAVERSINE" });
  }
}
