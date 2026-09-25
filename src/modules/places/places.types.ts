import type { GeoCoordinates } from "../locations/geo";

/**
 * One row of the "where to?" list. Providers that search by text (Nominatim,
 * the curated list) already know the coordinates; Google autocomplete only
 * returns an id, which the app resolves with `GET /places/resolve` when the
 * rider taps it.
 */
export interface PlaceSuggestion {
  /** Provider-prefixed: `featured:…`, `osm:N123`, `google:ChIJ…`. */
  id: string;
  /** Short label: "Prem Mandir". */
  name: string;
  /** Second list line, never repeating the name: "Raman Reiti, Vrindavan". */
  secondaryText: string;
  /** One-line address the ride is booked with (≤ 200 characters). */
  address: string;
  latitude?: number;
  longitude?: number;
  /** From the rider's position (or the service area), when known. */
  distanceMeters?: number;
  /** A curated Braj landmark rather than a provider result. */
  featured: boolean;
}

/** A place with coordinates — what pickup/destination are booked with. */
export interface ResolvedPlace {
  id: string;
  name: string;
  /** Full one-line address, ≤ 200 characters (the ride DTO limit). */
  address: string;
  latitude: number;
  longitude: number;
}

export interface ReverseGeocodedPlace extends ResolvedPlace {
  /**
   * True when no provider could name the spot and the address is only a
   * coordinate label. The pin is still exactly where the rider put it.
   */
  approximate: boolean;
}

export interface AutocompleteResult {
  suggestions: PlaceSuggestion[];
  /**
   * The search provider was unavailable (or not configured), so only the
   * curated places were searched. The app suggests "set on map" instead.
   */
  degraded: boolean;
}

export interface AutocompleteRequest {
  query: string;
  /** Rider's position: ranks nearby results first. */
  near?: GeoCoordinates;
  /** Groups one search session for providers that bill per session. */
  sessionToken?: string;
  limit: number;
}
