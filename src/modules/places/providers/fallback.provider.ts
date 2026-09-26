import { Logger } from "@nestjs/common";
import type { GeoCoordinates } from "../../locations/geo";
import type { PlaceSuggestion, ResolvedPlace } from "../places.types";
import { GeocodingProvider } from "./geocoding.provider";
import type { ProviderSearchRequest } from "./geocoding.provider";

/**
 * Two providers over the same id scheme, used as one (PLACES_PROVIDER=osm:
 * Photon, then Nominatim). The primary answers; the secondary steps in when
 * the primary fails (down, throttled, over budget) and — for resolve and
 * reverse — when it has no answer. Autocomplete never falls back on an empty
 * list: the secondary's tighter budget is kept for outages.
 */
export class FallbackGeocodingProvider extends GeocodingProvider {
  readonly name: string;
  readonly isConfigured = true;
  private readonly logger = new Logger(FallbackGeocodingProvider.name);

  constructor(
    private readonly primary: GeocodingProvider,
    private readonly secondary: GeocodingProvider,
  ) {
    super();
    this.name = `${primary.name}+${secondary.name}`;
  }

  async autocomplete(request: ProviderSearchRequest): Promise<Array<Omit<PlaceSuggestion, "featured">>> {
    try {
      return await this.primary.autocomplete(request);
    } catch (error) {
      this.stepIn("search", error);
      return this.secondary.autocomplete(request);
    }
  }

  async resolve(id: string, sessionToken?: string): Promise<ResolvedPlace | null> {
    try {
      const place = await this.primary.resolve(id, sessionToken);
      if (place) return place;
    } catch (error) {
      this.stepIn("lookup", error);
    }
    return this.secondary.resolve(id, sessionToken);
  }

  async reverse(point: GeoCoordinates): Promise<ResolvedPlace | null> {
    try {
      const place = await this.primary.reverse(point);
      if (place) return place;
    } catch (error) {
      this.stepIn("reverse geocoding", error);
    }
    return this.secondary.reverse(point);
  }

  private stepIn(operation: string, error: unknown): void {
    const reason = error instanceof Error ? error.message : String(error);
    this.logger.warn(`${this.primary.name} ${operation} failed (${reason}); trying ${this.secondary.name}`);
  }
}
