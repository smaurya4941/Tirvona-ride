import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { GeoCoordinates } from "./geo";
import { NoRouteFoundError, RouteProviderError } from "./route-estimator";
import type { RouteEstimate, RouteEstimator } from "./route-estimator";

export const GOOGLE_ROUTES_URL =
  "https://routes.googleapis.com/directions/v2:computeRoutes";

/**
 * Only what Tirvona uses. The field mask is also the bill: asking for more
 * (tolls, legs, advisories) moves requests to a pricier SKU.
 */
const FIELD_MASK =
  "routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline";

export type RoutesTravelMode = "DRIVE" | "TWO_WHEELER";

interface ComputeRoutesResponse {
  routes?: Array<{
    distanceMeters?: number;
    /** Protobuf Duration as JSON, e.g. "1234s". */
    duration?: string;
    polyline?: { encodedPolyline?: string };
  }>;
}

interface GoogleErrorBody {
  error?: { status?: string; message?: string };
}

const waypoint = ({ latitude, longitude }: GeoCoordinates) => ({
  location: { latLng: { latitude, longitude } },
});

/** "1234s" / "12.5s" → whole seconds. */
export function parseDurationSeconds(
  value: string | undefined,
): number | undefined {
  const match = /^(\d+(?:\.\d+)?)s$/.exec(value ?? "");
  return match ? Math.round(Number(match[1])) : undefined;
}

/**
 * Road distance, drive time and path from the Google Routes API
 * (`directions/v2:computeRoutes`). Server-side only: the key is restricted
 * to the Routes API and never ships in the app.
 *
 * Traffic-unaware by default (Routes "Basic" SKU); ROUTES_TRAFFIC_AWARE=true
 * switches to live-traffic durations at the "Advanced" SKU price.
 */
@Injectable()
export class GoogleRoutesEstimator implements RouteEstimator {
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly trafficAware: boolean;
  private readonly travelMode: RoutesTravelMode;

  constructor(config: ConfigService) {
    this.apiKey = config.get<string>("googleRoutesApiKey") ?? "";
    this.timeoutMs = config.getOrThrow<number>("routesTimeoutMs");
    this.trafficAware = config.getOrThrow<boolean>("routesTrafficAware");
    this.travelMode = config.getOrThrow<RoutesTravelMode>("routesTravelMode");
  }

  get isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  async estimate(
    origin: GeoCoordinates,
    destination: GeoCoordinates,
  ): Promise<RouteEstimate> {
    if (!this.isConfigured)
      throw new RouteProviderError("GOOGLE_ROUTES_API_KEY is not set", false);
    const body = {
      origin: waypoint(origin),
      destination: waypoint(destination),
      travelMode: this.travelMode,
      routingPreference: this.trafficAware
        ? "TRAFFIC_AWARE"
        : "TRAFFIC_UNAWARE",
      computeAlternativeRoutes: false,
      polylineQuality: "OVERVIEW",
      polylineEncoding: "ENCODED_POLYLINE",
      languageCode: "en-IN",
      regionCode: "IN",
      units: "METRIC",
    };

    let response: Response;
    try {
      response = await fetch(GOOGLE_ROUTES_URL, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Goog-Api-Key": this.apiKey,
          "X-Goog-FieldMask": FIELD_MASK,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new RouteProviderError(
        `Google Routes unreachable: ${reason}`,
        true,
      );
    }

    if (!response.ok) {
      const detail = (
        (await response.json().catch(() => ({}))) as GoogleErrorBody
      ).error;
      throw new RouteProviderError(
        `Google Routes ${response.status} ${detail?.status ?? ""}: ${detail?.message ?? "request failed"}`.slice(
          0,
          300,
        ),
        response.status === 429 || response.status >= 500,
      );
    }

    let payload: ComputeRoutesResponse;
    try {
      payload = (await response.json()) as ComputeRoutesResponse;
    } catch {
      throw new RouteProviderError(
        "Google Routes returned malformed JSON",
        true,
      );
    }

    // No route (island, closed road network) comes back as `{}`.
    const route = payload.routes?.[0];
    if (!route) throw new NoRouteFoundError();
    const durationSeconds = parseDurationSeconds(route.duration);
    // distanceMeters is omitted (proto default) when it is 0.
    const distanceMeters = route.distanceMeters ?? 0;
    if (durationSeconds === undefined || !Number.isFinite(distanceMeters))
      throw new RouteProviderError(
        "Google Routes answer is missing distance or duration",
        true,
      );

    const polyline = route.polyline?.encodedPolyline;
    return {
      distanceMeters: Math.round(distanceMeters),
      durationSeconds,
      provider: "GOOGLE_ROUTES",
      ...(polyline ? { polyline } : {}),
    };
  }
}
