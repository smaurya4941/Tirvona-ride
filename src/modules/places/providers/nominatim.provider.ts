import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { GeoCoordinates } from "../../locations/geo";
import { bookingAddress, secondaryLine } from "../place-text";
import type { PlaceSuggestion, ResolvedPlace } from "../places.types";
import { GeocodingProvider, GeocodingProviderError } from "./geocoding.provider";
import type { ProviderSearchRequest } from "./geocoding.provider";

interface NominatimPlace {
  osm_type?: string;
  osm_id?: number | string;
  lat?: string;
  lon?: string;
  name?: string;
  display_name?: string;
  error?: string;
}

const OSM_ID = /^osm:([NWR])(\d{1,20})$/;
const KM_PER_DEGREE = 111.32;

/**
 * OpenStreetMap Nominatim (public or self-hosted) over Node's fetch.
 *
 * The public instance's usage policy asks for an identifying User-Agent, a
 * contact e-mail and at most one request per second for the whole
 * application — this class spaces every call NOMINATIM_MIN_INTERVAL_MS apart
 * and refuses (retryably) rather than queue a rider for seconds. Results are
 * cached upstream by PlacesService. For heavy production traffic point
 * NOMINATIM_BASE_URL at a self-hosted instance or use PLACES_PROVIDER=google.
 */
@Injectable()
export class NominatimProvider extends GeocodingProvider {
  readonly name = "nominatim";
  readonly isConfigured = true;
  private readonly logger = new Logger(NominatimProvider.name);
  private readonly baseUrl: string;
  private readonly contactEmail: string;
  private readonly minIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly maxQueueWaitMs: number;
  private nextSlotAt = 0;

  constructor(config: ConfigService) {
    super();
    this.baseUrl = config.getOrThrow<string>("nominatimBaseUrl");
    this.contactEmail = config.get<string>("nominatimContactEmail") ?? "";
    this.minIntervalMs = config.getOrThrow<number>("nominatimMinIntervalMs");
    this.timeoutMs = config.getOrThrow<number>("placesTimeoutMs");
    this.maxQueueWaitMs = Math.min(this.timeoutMs, 3_000);
    if (this.baseUrl.includes("nominatim.openstreetmap.org") && !this.contactEmail)
      this.logger.warn(
        "NOMINATIM_CONTACT_EMAIL is not set: the public Nominatim may block this server. Set it, self-host, or use PLACES_PROVIDER=google",
      );
  }

  async autocomplete(request: ProviderSearchRequest): Promise<Array<Omit<PlaceSuggestion, "featured">>> {
    const latDelta = request.biasRadiusMeters / 1000 / KM_PER_DEGREE;
    const lngDelta = latDelta / Math.max(0.1, Math.cos((request.bias.latitude * Math.PI) / 180));
    const params = new URLSearchParams({
      q: request.query,
      format: "jsonv2",
      limit: String(request.limit),
      dedupe: "1",
      // A preference, not a fence: pilgrims also book from Agra or Delhi.
      viewbox: [
        request.bias.longitude - lngDelta,
        request.bias.latitude + latDelta,
        request.bias.longitude + lngDelta,
        request.bias.latitude - latDelta,
      ]
        .map((value) => value.toFixed(5))
        .join(","),
      bounded: "0",
    });
    if (request.countryCodes.length) params.set("countrycodes", request.countryCodes.join(","));
    const places = await this.get<NominatimPlace[]>("/search", params);
    return (Array.isArray(places) ? places : [])
      .map((place) => this.toResolved(place))
      .filter((place): place is ResolvedPlace & { secondaryText: string } => place !== null)
      .map(({ id, name, secondaryText, address, latitude, longitude }) => ({
        id,
        name,
        secondaryText,
        address,
        latitude,
        longitude,
      }));
  }

  async resolve(id: string): Promise<ResolvedPlace | null> {
    const match = OSM_ID.exec(id);
    if (!match) return null;
    const places = await this.get<NominatimPlace[]>(
      "/lookup",
      new URLSearchParams({ osm_ids: `${match[1]}${match[2]}`, format: "jsonv2" }),
    );
    const place = Array.isArray(places) ? this.toResolved(places[0]) : null;
    return place ? this.withoutSecondary(place) : null;
  }

  async reverse(point: GeoCoordinates): Promise<ResolvedPlace | null> {
    const place = await this.get<NominatimPlace>(
      "/reverse",
      new URLSearchParams({
        lat: point.latitude.toFixed(6),
        lon: point.longitude.toFixed(6),
        format: "jsonv2",
        // 18 = building level: a doorstep, not the neighbourhood.
        zoom: "18",
      }),
    );
    if (!place || place.error) return null;
    const resolved = this.toResolved(place);
    // The rider's pin is the truth; the provider only names it.
    return resolved ? { ...this.withoutSecondary(resolved), latitude: point.latitude, longitude: point.longitude } : null;
  }

  private withoutSecondary({ id, name, address, latitude, longitude }: ResolvedPlace): ResolvedPlace {
    return { id, name, address, latitude, longitude };
  }

  private toResolved(place: NominatimPlace | undefined): (ResolvedPlace & { secondaryText: string }) | null {
    if (!place?.display_name || !place.osm_type || place.osm_id === undefined) return null;
    const latitude = Number(place.lat);
    const longitude = Number(place.lon);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    const name = (place.name || place.display_name.split(",")[0] || "").trim();
    if (!name) return null;
    const secondaryText = secondaryLine(place.display_name, name);
    return {
      id: `osm:${place.osm_type.charAt(0).toUpperCase()}${place.osm_id}`,
      name,
      secondaryText,
      address: bookingAddress(name, secondaryText),
      latitude,
      longitude,
    };
  }

  private async get<T>(path: string, params: URLSearchParams): Promise<T> {
    params.set("accept-language", "en");
    if (this.contactEmail) params.set("email", this.contactEmail);
    await this.acquireSlot();
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}?${params.toString()}`, {
        headers: {
          Accept: "application/json",
          "User-Agent": `TirvonaRides/1.0${this.contactEmail ? ` (${this.contactEmail})` : ""}`,
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new GeocodingProviderError(`Nominatim unreachable: ${reason}`, true);
    }
    if (!response.ok)
      throw new GeocodingProviderError(
        `Nominatim ${response.status}`,
        response.status === 429 || response.status >= 500,
      );
    try {
      return (await response.json()) as T;
    } catch {
      throw new GeocodingProviderError("Nominatim returned malformed JSON", true);
    }
  }

  /**
   * Spaces calls minIntervalMs apart across the whole process. A caller that
   * would wait longer than maxQueueWaitMs is refused instead (the service
   * then falls back to the curated places), so a burst never piles up.
   */
  private async acquireSlot(): Promise<void> {
    if (this.minIntervalMs <= 0) return;
    const now = Date.now();
    const slot = Math.max(now, this.nextSlotAt);
    const wait = slot - now;
    if (wait > this.maxQueueWaitMs) throw new GeocodingProviderError("Nominatim request budget exhausted", true);
    this.nextSlotAt = slot + this.minIntervalMs;
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  }
}
