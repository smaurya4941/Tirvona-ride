import { Logger } from "@nestjs/common";
import type { GeoCoordinates } from "../../locations/geo";
import type { PlaceSuggestion, ResolvedPlace } from "../places.types";
import {
  GeocodingProvider,
  GeocodingProviderError,
} from "./geocoding.provider";
import type { ProviderSearchRequest } from "./geocoding.provider";

export interface FallbackOptions {
  /** Consecutive transient primary failures before the primary is skipped. */
  failureThreshold: number;
  /** How long the primary is skipped once tripped. 0 = never skip. */
  cooldownMs: number;
  now?: () => number;
}

const NO_BREAKER: FallbackOptions = {
  failureThreshold: Number.POSITIVE_INFINITY,
  cooldownMs: 0,
};

/**
 * Two providers used as one: PLACES_PROVIDER=osm (Photon, then Nominatim) and
 * PLACES_PROVIDER=google (Google, then the free OSM pair). The primary
 * answers; the secondary steps in when the primary fails (down, throttled,
 * over budget, bad key) and — for resolve and reverse — when it has no
 * answer. Autocomplete never falls back on an empty list: the secondary's
 * tighter budget is kept for outages.
 *
 * Ids stay routable across the pair: each provider returns null for ids it
 * did not issue (`google:…`, `osm:…`), so `resolve` reaches the right one.
 *
 * Optional circuit breaker: after `failureThreshold` consecutive transient
 * failures, or at once on a non-retryable one (key rejected, API disabled),
 * the primary is skipped for `cooldownMs`, so an outage costs no latency.
 */
export class FallbackGeocodingProvider extends GeocodingProvider {
  readonly name: string;
  readonly isConfigured = true;
  private readonly logger = new Logger(FallbackGeocodingProvider.name);
  private readonly now: () => number;
  private consecutiveFailures = 0;
  private skipUntil = 0;

  constructor(
    private readonly primary: GeocodingProvider,
    private readonly secondary: GeocodingProvider,
    private readonly options: FallbackOptions = NO_BREAKER,
  ) {
    super();
    this.name = `${primary.name}+${secondary.name}`;
    this.now = options.now ?? Date.now;
  }

  /** True while the primary is being skipped. */
  get isDegraded(): boolean {
    return this.now() < this.skipUntil;
  }

  async autocomplete(
    request: ProviderSearchRequest,
  ): Promise<Array<Omit<PlaceSuggestion, "featured">>> {
    if (!this.isDegraded) {
      try {
        const suggestions = await this.primary.autocomplete(request);
        this.recordSuccess();
        return suggestions;
      } catch (error) {
        this.stepIn("search", error);
      }
    }
    return this.secondary.autocomplete(request);
  }

  async resolve(
    id: string,
    sessionToken?: string,
  ): Promise<ResolvedPlace | null> {
    // Ids the primary issued can only be resolved by it, even while degraded.
    let primaryError: unknown;
    try {
      const place = await this.primary.resolve(id, sessionToken);
      this.recordSuccess();
      if (place) return place;
    } catch (error) {
      primaryError = error;
      this.stepIn("lookup", error);
    }
    const place = await this.secondary.resolve(id, sessionToken);
    // The secondary does not know the primary's ids: "not found" there means
    // "the primary is down", which callers must report as unavailable.
    if (!place && primaryError !== undefined) throw primaryError;
    return place;
  }

  async reverse(point: GeoCoordinates): Promise<ResolvedPlace | null> {
    if (!this.isDegraded) {
      try {
        const place = await this.primary.reverse(point);
        this.recordSuccess();
        if (place) return place;
      } catch (error) {
        this.stepIn("reverse geocoding", error);
      }
    }
    return this.secondary.reverse(point);
  }

  private recordSuccess(): void {
    this.consecutiveFailures = 0;
  }

  private stepIn(operation: string, error: unknown): void {
    const reason = error instanceof Error ? error.message : String(error);
    const retryable =
      error instanceof GeocodingProviderError ? error.retryable : true;
    this.consecutiveFailures += 1;
    if (
      this.options.cooldownMs > 0 &&
      (!retryable || this.consecutiveFailures >= this.options.failureThreshold)
    ) {
      this.skipUntil = this.now() + this.options.cooldownMs;
      this.consecutiveFailures = 0;
      this.logger.error(
        `${this.primary.name} ${operation} failed (${reason}); using ${this.secondary.name} for the next ${Math.round(
          this.options.cooldownMs / 1000,
        )}s`,
      );
      return;
    }
    this.logger.warn(
      `${this.primary.name} ${operation} failed (${reason}); trying ${this.secondary.name}`,
    );
  }
}
