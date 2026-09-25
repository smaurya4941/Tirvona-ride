import type { GeoCoordinates } from "../../locations/geo";
import type { PlaceSuggestion, ResolvedPlace } from "../places.types";

export interface ProviderSearchRequest {
  query: string;
  /** Where to rank results around: the rider, else the service area centre. */
  bias: GeoCoordinates;
  biasRadiusMeters: number;
  countryCodes: string[];
  sessionToken?: string;
  limit: number;
}

/** A provider call failed (network, timeout, quota, bad key, rate limit). */
export class GeocodingProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "GeocodingProviderError";
  }
}

/**
 * The only door to a geocoding provider. PlacesService depends on this
 * abstraction; PlacesModule binds Nominatim, Google Places or a disabled
 * provider from PLACES_PROVIDER, and the e2e suite binds an in-memory fake.
 *
 * Implementations throw GeocodingProviderError for provider trouble and
 * return empty results / null for "nothing there".
 */
export abstract class GeocodingProvider {
  abstract readonly name: string;
  abstract readonly isConfigured: boolean;

  /** Text search as the rider types. Suggestions carry no `featured` flag. */
  abstract autocomplete(request: ProviderSearchRequest): Promise<Array<Omit<PlaceSuggestion, "featured">>>;

  /** Coordinates for a suggestion id this provider issued; null if unknown. */
  abstract resolve(id: string, sessionToken?: string): Promise<ResolvedPlace | null>;

  /** The nearest addressable place to a point; null if none. */
  abstract reverse(point: GeoCoordinates): Promise<ResolvedPlace | null>;
}

/** PLACES_PROVIDER=none: only the curated popular places are searchable. */
export class DisabledGeocodingProvider extends GeocodingProvider {
  readonly name = "none";
  readonly isConfigured = false;

  async autocomplete(): Promise<Array<Omit<PlaceSuggestion, "featured">>> {
    return [];
  }

  async resolve(): Promise<ResolvedPlace | null> {
    return null;
  }

  async reverse(): Promise<ResolvedPlace | null> {
    return null;
  }
}
