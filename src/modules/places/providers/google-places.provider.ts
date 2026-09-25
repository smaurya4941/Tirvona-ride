import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { GeoCoordinates } from "../../locations/geo";
import { bookingAddress, secondaryLine } from "../place-text";
import type { PlaceSuggestion, ResolvedPlace } from "../places.types";
import { GeocodingProvider, GeocodingProviderError } from "./geocoding.provider";
import type { ProviderSearchRequest } from "./geocoding.provider";

interface AutocompleteResponse {
  suggestions?: Array<{
    placePrediction?: {
      placeId?: string;
      text?: { text?: string };
      structuredFormat?: { mainText?: { text?: string }; secondaryText?: { text?: string } };
      distanceMeters?: number;
    };
  }>;
}

interface PlaceDetailsResponse {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
}

interface GeocodeResponse {
  status?: string;
  error_message?: string;
  results?: Array<{ place_id?: string; formatted_address?: string }>;
}

const PLACES_API = "https://places.googleapis.com/v1";
const GEOCODE_API = "https://maps.googleapis.com/maps/api/geocode/json";
const GOOGLE_ID = /^google:([A-Za-z0-9_-]{10,300})$/;
/** Places API (New) caps a location-bias circle at 50 km. */
const MAX_BIAS_RADIUS_METERS = 50_000;

/**
 * Google Places API (New) for autocomplete + place details, and the
 * Geocoding API for reverse lookups. The key stays on the server.
 *
 * Autocomplete and the details call that follows share the app's session
 * token, which Google bills as one session instead of per keystroke.
 */
@Injectable()
export class GooglePlacesProvider extends GeocodingProvider {
  readonly name = "google";
  readonly isConfigured: boolean;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    super();
    this.apiKey = config.get<string>("googleMapsApiKey") ?? "";
    this.timeoutMs = config.getOrThrow<number>("placesTimeoutMs");
    this.isConfigured = Boolean(this.apiKey);
  }

  async autocomplete(request: ProviderSearchRequest): Promise<Array<Omit<PlaceSuggestion, "featured">>> {
    const body = {
      input: request.query,
      languageCode: "en",
      includedRegionCodes: request.countryCodes,
      locationBias: {
        circle: {
          center: request.bias,
          radius: Math.min(request.biasRadiusMeters, MAX_BIAS_RADIUS_METERS),
        },
      },
      origin: request.bias,
      ...(request.sessionToken ? { sessionToken: request.sessionToken } : {}),
    };
    const response = await this.call<AutocompleteResponse>(`${PLACES_API}/places:autocomplete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const suggestions: Array<Omit<PlaceSuggestion, "featured">> = [];
    for (const { placePrediction: prediction } of response.suggestions ?? []) {
      if (!prediction?.placeId) continue;
      const name = (prediction.structuredFormat?.mainText?.text ?? prediction.text?.text ?? "").trim();
      if (!name) continue;
      const secondaryText = secondaryLine(prediction.structuredFormat?.secondaryText?.text ?? "", name);
      suggestions.push({
        id: `google:${prediction.placeId}`,
        name,
        secondaryText,
        address: bookingAddress(name, secondaryText),
        ...(typeof prediction.distanceMeters === "number" ? { distanceMeters: prediction.distanceMeters } : {}),
      });
      if (suggestions.length >= request.limit) break;
    }
    return suggestions;
  }

  async resolve(id: string, sessionToken?: string): Promise<ResolvedPlace | null> {
    const match = GOOGLE_ID.exec(id);
    if (!match) return null;
    const query = new URLSearchParams({ languageCode: "en" });
    if (sessionToken) query.set("sessionToken", sessionToken);
    let place: PlaceDetailsResponse;
    try {
      place = await this.call<PlaceDetailsResponse>(`${PLACES_API}/places/${match[1]}?${query.toString()}`, {
        headers: { "X-Goog-FieldMask": "id,displayName,formattedAddress,location" },
      });
    } catch (error) {
      if (error instanceof GooglePlaceNotFound) return null;
      throw error;
    }
    const latitude = place.location?.latitude;
    const longitude = place.location?.longitude;
    if (typeof latitude !== "number" || typeof longitude !== "number") return null;
    const name = (place.displayName?.text ?? place.formattedAddress?.split(",")[0] ?? "").trim();
    if (!name) return null;
    return {
      id,
      name,
      address: bookingAddress(name, secondaryLine(place.formattedAddress ?? "", name)),
      latitude,
      longitude,
    };
  }

  async reverse(point: GeoCoordinates): Promise<ResolvedPlace | null> {
    const query = new URLSearchParams({
      latlng: `${point.latitude.toFixed(6)},${point.longitude.toFixed(6)}`,
      language: "en",
      key: this.apiKey,
    });
    const response = await this.call<GeocodeResponse>(`${GEOCODE_API}?${query.toString()}`, {}, false);
    if (response.status === "ZERO_RESULTS") return null;
    if (response.status !== "OK")
      throw new GeocodingProviderError(
        `Google Geocoding ${response.status ?? "error"}: ${response.error_message ?? ""}`.trim(),
        response.status === "OVER_QUERY_LIMIT" || response.status === "UNKNOWN_ERROR",
      );
    const result = response.results?.[0];
    if (!result?.formatted_address) return null;
    const name = result.formatted_address.split(",")[0].trim();
    return {
      id: result.place_id ? `google:${result.place_id}` : `pin:${point.latitude.toFixed(6)},${point.longitude.toFixed(6)}`,
      name,
      address: bookingAddress(name, secondaryLine(result.formatted_address, name)),
      latitude: point.latitude,
      longitude: point.longitude,
    };
  }

  private async call<T>(url: string, init: RequestInit, sendKeyHeader = true): Promise<T> {
    if (!this.isConfigured) throw new GeocodingProviderError("Google Maps API key is not set", false);
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers: {
          Accept: "application/json",
          ...(sendKeyHeader ? { "X-Goog-Api-Key": this.apiKey } : {}),
          ...(init.headers as Record<string, string> | undefined),
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new GeocodingProviderError(`Google Places unreachable: ${reason}`, true);
    }
    if (response.status === 404) throw new GooglePlaceNotFound();
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: { status?: string; message?: string } };
      throw new GeocodingProviderError(
        `Google Places ${response.status} ${body.error?.status ?? ""}: ${body.error?.message ?? "request failed"}`.slice(0, 300),
        response.status === 429 || response.status >= 500,
      );
    }
    try {
      return (await response.json()) as T;
    } catch {
      throw new GeocodingProviderError("Google Places returned malformed JSON", true);
    }
  }
}

class GooglePlaceNotFound extends Error {}
