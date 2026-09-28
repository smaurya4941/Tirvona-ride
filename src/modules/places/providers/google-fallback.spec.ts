import type { GeoCoordinates } from "../../locations/geo";
import type { PlaceSuggestion, ResolvedPlace } from "../places.types";
import { FallbackGeocodingProvider } from "./fallback.provider";
import { GeocodingProvider, GeocodingProviderError } from "./geocoding.provider";
import type { ProviderSearchRequest } from "./geocoding.provider";

type Suggestion = Omit<PlaceSuggestion, "featured">;

/** A provider whose three calls are jest mocks. */
class MockProvider extends GeocodingProvider {
  readonly isConfigured = true;
  readonly autocomplete = jest.fn<Promise<Suggestion[]>, [ProviderSearchRequest]>();
  readonly resolve = jest.fn<Promise<ResolvedPlace | null>, [string, string?]>();
  readonly reverse = jest.fn<Promise<ResolvedPlace | null>, [GeoCoordinates]>();

  constructor(readonly name: string) {
    super();
  }
}

const REQUEST: ProviderSearchRequest = {
  query: "prem mandir",
  bias: { latitude: 27.54, longitude: 77.67 },
  biasRadiusMeters: 50_000,
  countryCodes: ["in"],
  sessionToken: "session-1",
  limit: 8,
};
const POINT = { latitude: 28.627, longitude: 77.3727 };
const place = (id: string): ResolvedPlace => ({ id, name: id, address: id, latitude: 27.57, longitude: 77.67 });
const suggestion = (id: string): Suggestion => ({ id, name: id, secondaryText: "Vrindavan", address: id });

describe("FallbackGeocodingProvider — Google with OSM fallback", () => {
  let clock: number;
  let google: MockProvider;
  let osm: MockProvider;
  let provider: FallbackGeocodingProvider;

  beforeEach(() => {
    clock = 1_000_000;
    google = new MockProvider("google");
    osm = new MockProvider("photon+nominatim");
    google.autocomplete.mockResolvedValue([suggestion("google:abc")]);
    google.resolve.mockImplementation(async (id) => (id.startsWith("google:") ? place(id) : null));
    google.reverse.mockResolvedValue(place("google:rev"));
    osm.autocomplete.mockResolvedValue([suggestion("osm:N1")]);
    osm.resolve.mockImplementation(async (id) => (id.startsWith("osm:") ? place(id) : null));
    osm.reverse.mockResolvedValue(place("osm:rev"));
    provider = new FallbackGeocodingProvider(google, osm, { failureThreshold: 3, cooldownMs: 60_000, now: () => clock });
  });

  it("answers from Google while it is healthy, passing the session token through", async () => {
    expect(await provider.autocomplete(REQUEST)).toEqual([suggestion("google:abc")]);
    expect(await provider.resolve("google:abc", "session-1")).toEqual(place("google:abc"));
    expect(await provider.reverse(POINT)).toEqual(place("google:rev"));
    expect(google.resolve).toHaveBeenCalledWith("google:abc", "session-1");
    expect(osm.autocomplete).not.toHaveBeenCalled();
    expect(osm.reverse).not.toHaveBeenCalled();
    expect(provider.name).toBe("google+photon+nominatim");
  });

  it("searches OSM when Google fails, but not when Google merely finds nothing", async () => {
    google.autocomplete.mockRejectedValueOnce(new GeocodingProviderError("Google Places 503", true));
    expect(await provider.autocomplete(REQUEST)).toEqual([suggestion("osm:N1")]);

    google.autocomplete.mockResolvedValueOnce([]);
    expect(await provider.autocomplete(REQUEST)).toEqual([]);
    expect(osm.autocomplete).toHaveBeenCalledTimes(1);
  });

  it("routes ids to the provider that issued them", async () => {
    // A result that came from OSM during an outage still resolves afterwards.
    expect(await provider.resolve("osm:N1")).toEqual(place("osm:N1"));
    expect(google.resolve).toHaveBeenCalledWith("osm:N1", undefined);
  });

  it("reports a Google id as unavailable (not 'not found') while Google is down", async () => {
    const outage = new GeocodingProviderError("Google Places unreachable: timeout", true);
    google.resolve.mockRejectedValueOnce(outage);
    await expect(provider.resolve("google:abc")).rejects.toBe(outage);
  });

  it("reverse geocodes with OSM when Google fails or has no address", async () => {
    google.reverse.mockRejectedValueOnce(new GeocodingProviderError("OVER_QUERY_LIMIT", true));
    expect(await provider.reverse(POINT)).toEqual(place("osm:rev"));
    google.reverse.mockResolvedValueOnce(null);
    expect(await provider.reverse(POINT)).toEqual(place("osm:rev"));
  });

  it("skips Google for the cooldown after repeated transient failures", async () => {
    google.autocomplete.mockRejectedValue(new GeocodingProviderError("Google Places 503", true));
    for (let i = 0; i < 3; i += 1) await provider.autocomplete(REQUEST);
    expect(provider.isDegraded).toBe(true);

    await provider.autocomplete(REQUEST);
    await provider.reverse(POINT);
    expect(google.autocomplete).toHaveBeenCalledTimes(3);
    expect(google.reverse).not.toHaveBeenCalled();

    clock += 60_001;
    google.autocomplete.mockResolvedValue([suggestion("google:back")]);
    expect(await provider.autocomplete(REQUEST)).toEqual([suggestion("google:back")]);
  });

  it("trips at once when Google rejects the key or the API is disabled", async () => {
    google.autocomplete.mockRejectedValueOnce(
      new GeocodingProviderError("Google Places 403 PERMISSION_DENIED: API key not authorized", false),
    );
    await provider.autocomplete(REQUEST);
    expect(provider.isDegraded).toBe(true);
  });

  it("still resolves Google ids while degraded (only Google knows them)", async () => {
    google.autocomplete.mockRejectedValueOnce(new GeocodingProviderError("403", false));
    await provider.autocomplete(REQUEST);
    expect(provider.isDegraded).toBe(true);
    expect(await provider.resolve("google:abc")).toEqual(place("google:abc"));
  });

  it("without breaker options it never skips the primary (PLACES_PROVIDER=osm behaviour)", async () => {
    const plain = new FallbackGeocodingProvider(google, osm);
    google.autocomplete.mockRejectedValue(new GeocodingProviderError("403", false));
    for (let i = 0; i < 5; i += 1) await plain.autocomplete(REQUEST);
    expect(google.autocomplete).toHaveBeenCalledTimes(5);
    expect(plain.isDegraded).toBe(false);
  });
});
