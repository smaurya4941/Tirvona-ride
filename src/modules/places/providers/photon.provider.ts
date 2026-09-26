import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { GeoCoordinates } from "../../locations/geo";
import { bookingAddress, secondaryLine } from "../place-text";
import type { PlaceSuggestion, ResolvedPlace } from "../places.types";
import { GeocodingProvider, GeocodingProviderError } from "./geocoding.provider";
import type { ProviderSearchRequest } from "./geocoding.provider";
import { RequestSpacer } from "./request-spacer";

interface PhotonProperties {
  osm_type?: string;
  osm_id?: number | string;
  name?: string;
  housenumber?: string;
  street?: string;
  locality?: string;
  district?: string;
  city?: string;
  state?: string;
  postcode?: string;
  countrycode?: string;
}

interface PhotonFeature {
  properties?: PhotonProperties;
  geometry?: { type?: string; coordinates?: unknown };
}

interface PhotonResponse {
  features?: PhotonFeature[];
}

type Suggestion = Omit<PlaceSuggestion, "featured">;

/** Photon's result ceiling; extra rows leave room for the country filter. */
const MAX_FETCH = 20;
/**
 * Location bias: zoom 12 (~10 km) with a low prominence weight puts the
 * Fortis in the rider's own sector above a bigger one across town, while a
 * famous place far away ("Taj Mahal" typed in Noida) still makes the list.
 * Tuned against the public instance with Noida and Vrindavan queries.
 */
const BIAS_ZOOM = "12";
const BIAS_PROMINENCE_SCALE = "0.1";
/** Reverse geocoding only names a spot within this many kilometres. */
const REVERSE_RADIUS_KM = 0.3;

/**
 * Komoot Photon (https://photon.komoot.io, or self-hosted) — a free
 * search-as-you-type geocoder over OpenStreetMap data. Unlike Nominatim it
 * matches word prefixes ("noida sec" → "Noida Sector 18") and ranks by
 * distance from the rider, which is what a pickup/destination box needs.
 *
 * Ids use the same `osm:N123` scheme as Nominatim, so a fallback Nominatim
 * can resolve them. Photon has no lookup-by-id endpoint: `resolve` returns
 * null (its suggestions always carry coordinates, so the app never asks).
 *
 * The public instance is offered under a fair-use policy: calls are spaced
 * PHOTON_MIN_INTERVAL_MS apart and every answer is cached by PlacesService.
 * For heavy traffic run the Photon Docker image with an India extract and
 * point PHOTON_BASE_URL at it (then set PHOTON_MIN_INTERVAL_MS=0).
 */
@Injectable()
export class PhotonProvider extends GeocodingProvider {
  readonly name = "photon";
  readonly isConfigured = true;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly spacer: RequestSpacer;

  constructor(config: ConfigService) {
    super();
    this.baseUrl = config.getOrThrow<string>("photonBaseUrl");
    this.timeoutMs = config.getOrThrow<number>("placesTimeoutMs");
    this.spacer = new RequestSpacer(
      "Photon",
      config.getOrThrow<number>("photonMinIntervalMs"),
      Math.min(this.timeoutMs, 1_500),
    );
  }

  async autocomplete(request: ProviderSearchRequest): Promise<Suggestion[]> {
    const params = new URLSearchParams({
      q: request.query,
      limit: String(Math.min(MAX_FETCH, request.limit * 2)),
      lat: request.bias.latitude.toFixed(5),
      lon: request.bias.longitude.toFixed(5),
      zoom: BIAS_ZOOM,
      location_bias_scale: BIAS_PROMINENCE_SCALE,
    });
    const response = await this.get<PhotonResponse>("/api/", params);
    const countries = new Set(request.countryCodes.map((code) => code.toUpperCase()));
    const suggestions: Suggestion[] = [];
    for (const feature of response.features ?? []) {
      const country = feature.properties?.countrycode?.toUpperCase();
      if (countries.size && (!country || !countries.has(country))) continue;
      const place = this.toSuggestion(feature);
      if (!place) continue;
      // Photon often returns the node, way and relation of one building.
      if (
        suggestions.some((existing) => existing.name === place.name && existing.secondaryText === place.secondaryText)
      )
        continue;
      suggestions.push(place);
      if (suggestions.length >= request.limit) break;
    }
    return suggestions;
  }

  async resolve(): Promise<ResolvedPlace | null> {
    return null;
  }

  async reverse(point: GeoCoordinates): Promise<ResolvedPlace | null> {
    const response = await this.get<PhotonResponse>(
      "/reverse",
      new URLSearchParams({
        lat: point.latitude.toFixed(6),
        lon: point.longitude.toFixed(6),
        limit: "1",
        radius: String(REVERSE_RADIUS_KM),
      }),
    );
    const place = this.toSuggestion(response.features?.[0]);
    if (!place) return null;
    // The rider's pin is the truth; the provider only names it.
    return {
      id: place.id,
      name: place.name,
      address: place.address,
      latitude: point.latitude,
      longitude: point.longitude,
    };
  }

  private toSuggestion(feature: PhotonFeature | undefined): Suggestion | null {
    const props = feature?.properties;
    const coordinates = feature?.geometry?.coordinates;
    if (!props?.osm_type || props.osm_id === undefined || !Array.isArray(coordinates)) return null;
    const longitude = Number(coordinates[0]);
    const latitude = Number(coordinates[1]);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

    const streetLine = [props.housenumber, props.street].filter(Boolean).join(" ").trim();
    const name = (props.name || streetLine || props.street || props.district || props.city || "").trim();
    if (!name) return null;
    const parts = [
      props.name && streetLine ? streetLine : "",
      props.locality,
      props.district,
      props.city,
      props.state,
    ].filter((part): part is string => Boolean(part && part.trim()));
    const secondaryText = secondaryLine([name, ...parts].join(", "), name);
    return {
      id: `osm:${props.osm_type.charAt(0).toUpperCase()}${props.osm_id}`,
      name,
      secondaryText,
      address: bookingAddress(name, secondaryText),
      latitude,
      longitude,
    };
  }

  private async get<T>(path: string, params: URLSearchParams): Promise<T> {
    params.set("lang", "en");
    await this.spacer.acquire();
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}?${params.toString()}`, {
        headers: {
          Accept: "application/json",
          "User-Agent": "TirvonaRides/1.0",
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new GeocodingProviderError(`Photon unreachable: ${reason}`, true);
    }
    if (!response.ok)
      throw new GeocodingProviderError(`Photon ${response.status}`, response.status === 429 || response.status >= 500);
    try {
      return (await response.json()) as T;
    } catch {
      throw new GeocodingProviderError("Photon returned malformed JSON", true);
    }
  }
}
