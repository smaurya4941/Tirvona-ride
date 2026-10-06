import { Logger } from "@nestjs/common";
import { TtlCache } from "../../common/cache/ttl-cache";
import type { GeoCoordinates } from "./geo";
import { NoRouteFoundError, RouteProviderError } from "./route-estimator";
import type { RouteEstimate, RouteEstimator } from "./route-estimator";

export interface ResilientRouteOptions {
  cacheTtlMs: number;
  cacheMaxEntries: number;
  /** Consecutive transient failures before the provider is skipped. */
  failureThreshold: number;
  /** How long the provider is skipped once the threshold is reached. */
  cooldownMs: number;
  now?: () => number;
}

/** ~11 m: points closer than this share a cached route. */
const COORDINATE_DECIMALS = 4;

const pointKey = ({ latitude, longitude }: GeoCoordinates): string =>
  `${latitude.toFixed(COORDINATE_DECIMALS)},${longitude.toFixed(COORDINATE_DECIMALS)}`;

/**
 * Wraps a road-routing provider so that booking never depends on it:
 *
 * - **Cache**: answers are kept per (origin, destination) rounded to ~11 m,
 *   so "estimate → estimate/all → book" for one trip costs one provider call,
 *   and concurrent identical requests share a single call.
 * - **Fallback**: any provider failure answers with the straight-line
 *   estimate instead (never cached, so the next request tries again).
 * - **Circuit breaker**: after `failureThreshold` consecutive transient
 *   failures, or at once on a configuration error (bad key, API disabled),
 *   the provider is skipped for `cooldownMs` — an outage costs no latency.
 */
export class ResilientRouteEstimator implements RouteEstimator {
  private readonly logger = new Logger(ResilientRouteEstimator.name);
  private readonly cache: TtlCache<RouteEstimate>;
  private readonly now: () => number;
  private consecutiveFailures = 0;
  private skipUntil = 0;

  constructor(
    private readonly primary: RouteEstimator,
    private readonly fallback: RouteEstimator,
    private readonly options: ResilientRouteOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.cache = new TtlCache<RouteEstimate>(options.cacheMaxEntries, this.now);
  }

  /** True while the breaker is open and every estimate is straight-line. */
  get isDegraded(): boolean {
    return this.now() < this.skipUntil;
  }

  async estimate(
    origin: GeoCoordinates,
    destination: GeoCoordinates,
  ): Promise<RouteEstimate> {
    if (this.isDegraded) return this.fallback.estimate(origin, destination);
    const key = `${pointKey(origin)}>${pointKey(destination)}`;
    try {
      const route = await this.cache.getOrLoad(
        key,
        this.options.cacheTtlMs,
        () => this.primary.estimate(origin, destination),
      );
      this.consecutiveFailures = 0;
      return route;
    } catch (error) {
      this.recordFailure(error);
      return this.fallback.estimate(origin, destination);
    }
  }

  private recordFailure(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    // A genuinely unroutable pair says nothing about provider health.
    if (error instanceof NoRouteFoundError) {
      this.logger.warn(
        `Route provider found no route; using straight-line estimate`,
      );
      return;
    }
    const retryable =
      error instanceof RouteProviderError ? error.retryable : true;
    this.consecutiveFailures += 1;
    if (
      !retryable ||
      this.consecutiveFailures >= this.options.failureThreshold
    ) {
      this.skipUntil = this.now() + this.options.cooldownMs;
      this.consecutiveFailures = 0;
      this.logger.error(
        `Route provider failing (${message}); straight-line estimates for the next ${Math.round(
          this.options.cooldownMs / 1000,
        )}s`,
      );
      return;
    }
    this.logger.warn(
      `Route provider failed (${message}); using straight-line estimate`,
    );
  }
}
