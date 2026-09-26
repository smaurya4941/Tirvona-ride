import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ApiException, apiNotFound } from "../../common/exceptions/api.exception";
import type { GeoCoordinates } from "../locations/geo";
import { haversineMeters } from "../locations/geo";
import {
  featuredNear,
  featuredToResolved,
  findFeatured,
  isNearFeatured,
  popularPlaces,
  searchFeatured,
} from "./featured-places";
import { coordinateLabel, normalizeQuery } from "./place-text";
import type {
  AutocompleteRequest,
  AutocompleteResult,
  PlaceSuggestion,
  ResolvedPlace,
  ReverseGeocodedPlace,
} from "./places.types";
import { GeocodingProvider } from "./providers/geocoding.provider";
import { TtlCache } from "./ttl-cache";

type ProviderSuggestion = Omit<PlaceSuggestion, "featured">;

/** Curated matches shown ahead of provider results. */
const MAX_FEATURED_IN_RESULTS = 3;
/** A provider result this close to a curated match is the same place… */
const DUPLICATE_RADIUS_METERS = 40;
/** …as is one with the same name within this distance. */
const SAME_NAME_RADIUS_METERS = 2_000;
/** A dropped pin this close to a curated place takes that place's name. */
const FEATURED_SNAP_METERS = 60;

/**
 * Place search for the booking flow: autocomplete, resolving a tapped
 * suggestion to coordinates, reverse geocoding ("current location", a pin
 * on the map) and the curated popular places.
 *
 * Every provider answer is cached and concurrent identical lookups share one
 * provider call, so a debounced search box costs a fraction of a request per
 * keystroke. Provider outages degrade instead of failing: search falls back
 * to the curated list, and reverse geocoding to a coordinate label — a rider
 * can always book from where they are standing.
 */
@Injectable()
export class PlacesService {
  private readonly logger = new Logger(PlacesService.name);
  private readonly bias: GeoCoordinates;
  private readonly biasRadiusMeters: number;
  private readonly featuredRadiusMeters: number;
  private readonly countryCodes: string[];
  private readonly cacheTtlMs: number;
  private readonly searchCache: TtlCache<ProviderSuggestion[]>;
  private readonly resolveCache: TtlCache<ResolvedPlace | null>;
  private readonly reverseCache: TtlCache<ResolvedPlace | null>;

  constructor(
    private readonly provider: GeocodingProvider,
    config: ConfigService,
  ) {
    this.bias = {
      latitude: config.getOrThrow<number>("placesBiasLatitude"),
      longitude: config.getOrThrow<number>("placesBiasLongitude"),
    };
    this.biasRadiusMeters = config.getOrThrow<number>("placesBiasRadiusKm") * 1000;
    this.featuredRadiusMeters = config.getOrThrow<number>("placesFeaturedRadiusKm") * 1000;
    this.countryCodes = config.getOrThrow<string[]>("placesCountryCodes");
    this.cacheTtlMs = config.getOrThrow<number>("placesCacheTtlSeconds") * 1000;
    const maxEntries = config.getOrThrow<number>("placesCacheMaxEntries");
    this.searchCache = new TtlCache(maxEntries);
    this.resolveCache = new TtlCache(maxEntries);
    this.reverseCache = new TtlCache(maxEntries);
    if (!provider.isConfigured)
      this.logger.warn("No place-search provider is configured: only the curated popular places are searchable");
  }

  async autocomplete(request: AutocompleteRequest): Promise<AutocompleteResult> {
    const query = normalizeQuery(request.query);
    const featured = searchFeatured(query, request.near, MAX_FEATURED_IN_RESULTS);
    if (!this.provider.isConfigured || query.length < 2)
      return { suggestions: featured.slice(0, request.limit), degraded: !this.provider.isConfigured };

    const bias = request.near ?? this.bias;
    // Rounded to ~5 km so riders in the same area share cache entries.
    const key = `${this.provider.name}|${query}|${bias.latitude.toFixed(2)},${bias.longitude.toFixed(2)}|${request.limit}`;
    let fromProvider: ProviderSuggestion[];
    try {
      fromProvider = await this.searchCache.getOrLoad(key, this.cacheTtlMs, () =>
        this.provider.autocomplete({
          query: request.query.trim(),
          bias,
          biasRadiusMeters: this.biasRadiusMeters,
          countryCodes: this.countryCodes,
          sessionToken: request.sessionToken,
          limit: request.limit,
        }),
      );
    } catch (error) {
      this.logger.warn(`Place search failed, serving curated places only: ${describe(error)}`);
      return { suggestions: featured.slice(0, request.limit), degraded: true };
    }

    const provided = fromProvider.map((suggestion) => ({ ...withDistance(suggestion, request.near), featured: false }));
    // In Braj the curated landmarks lead; elsewhere (a rider in Noida typing
    // "gokul" wants the local Gokul first) they follow the local results.
    const [first, then] = this.isInBraj(request.near) ? [featured, provided] : [provided, featured];
    const merged: PlaceSuggestion[] = [];
    for (const suggestion of [...first, ...then]) {
      if (merged.length >= request.limit) break;
      if (merged.some((existing) => sameSpot(existing, suggestion))) continue;
      merged.push(suggestion);
    }
    return { suggestions: merged, degraded: false };
  }

  /** Coordinates for a suggestion the rider tapped. */
  async resolve(id: string, sessionToken?: string): Promise<ResolvedPlace> {
    const curated = findFeatured(id);
    if (curated) return featuredToResolved(curated);

    let place: ResolvedPlace | null;
    try {
      place = await this.resolveCache.getOrLoad(`${this.provider.name}|${id}`, this.cacheTtlMs, () =>
        this.provider.resolve(id, sessionToken),
      );
    } catch (error) {
      this.logger.warn(`Place lookup failed for ${id}: ${describe(error)}`);
      throw new ApiException(
        HttpStatus.SERVICE_UNAVAILABLE,
        "Place search is temporarily unavailable. Please try again or set the location on the map.",
        "PLACES_UNAVAILABLE",
      );
    }
    if (!place) throw apiNotFound("That place could not be found. Please search again.", "PLACE_NOT_FOUND");
    return place;
  }

  /** Names the spot at a coordinate. Always answers; see `approximate`. */
  async reverse(point: GeoCoordinates): Promise<ReverseGeocodedPlace> {
    const curated = featuredNear(point, FEATURED_SNAP_METERS);
    if (curated) return { ...featuredToResolved(curated), ...pinned(point), approximate: false };

    // ~11 m cells: GPS jitter between two taps hits the same entry.
    const key = `${this.provider.name}|${point.latitude.toFixed(4)},${point.longitude.toFixed(4)}`;
    let named: ResolvedPlace | null = null;
    if (this.provider.isConfigured) {
      try {
        named = await this.reverseCache.getOrLoad(key, this.cacheTtlMs, () => this.provider.reverse(point));
      } catch (error) {
        this.logger.warn(`Reverse geocoding failed: ${describe(error)}`);
      }
    }
    if (named) return { ...named, ...pinned(point), approximate: false };

    const label = coordinateLabel(point.latitude, point.longitude);
    return {
      id: `pin:${point.latitude.toFixed(6)},${point.longitude.toFixed(6)}`,
      name: "Pinned location",
      address: label,
      ...pinned(point),
      approximate: true,
    };
  }

  /** Curated places, nearest first; none for a rider far from Braj. */
  popular(near: GeoCoordinates | undefined, limit: number): PlaceSuggestion[] {
    return this.isInBraj(near) ? popularPlaces(near, limit) : [];
  }

  /** Unknown positions count as in Braj, the service area. */
  private isInBraj(near: GeoCoordinates | undefined): boolean {
    return !near || isNearFeatured(near, this.featuredRadiusMeters);
  }
}

/** The rider's exact point wins over the provider's snapped coordinates. */
const pinned = (point: GeoCoordinates): GeoCoordinates => ({
  latitude: point.latitude,
  longitude: point.longitude,
});

/**
 * Distances are measured from the rider only: a provider figure measured
 * from a (cache-rounded) bias point would be misleading, so it is dropped.
 */
function withDistance(suggestion: ProviderSuggestion, near?: GeoCoordinates): ProviderSuggestion {
  const { id, name, secondaryText, address, latitude, longitude } = suggestion;
  const base: ProviderSuggestion = { id, name, secondaryText, address, latitude, longitude };
  if (!near || latitude === undefined || longitude === undefined) return base;
  return { ...base, distanceMeters: Math.round(haversineMeters(near, { latitude, longitude })) };
}

function sameSpot(a: ProviderSuggestion, b: ProviderSuggestion): boolean {
  const sameName = normalizeQuery(a.name) === normalizeQuery(b.name);
  if (a.latitude === undefined || a.longitude === undefined || b.latitude === undefined || b.longitude === undefined)
    return sameName;
  const meters = haversineMeters(
    { latitude: a.latitude, longitude: a.longitude },
    { latitude: b.latitude, longitude: b.longitude },
  );
  return meters <= DUPLICATE_RADIUS_METERS || (sameName && meters <= SAME_NAME_RADIUS_METERS);
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));
