import type { ConfigService } from "@nestjs/config";
import { FallbackGeocodingProvider } from "./fallback.provider";
import { GeocodingProvider, GeocodingProviderError } from "./geocoding.provider";
import { PhotonProvider } from "./photon.provider";
import { RequestSpacer } from "./request-spacer";

const configOf = (settings: Record<string, unknown>) =>
  ({
    get: (key: string) => settings[key],
    getOrThrow: (key: string) => {
      if (!(key in settings)) throw new Error(`missing ${key}`);
      return settings[key];
    },
  }) as unknown as ConfigService;

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const realFetch = global.fetch;
afterAll(() => {
  global.fetch = realFetch;
});

// Sector 62, Noida — where the app is tested from.
const noidaSearch = {
  query: "sector 62",
  bias: { latitude: 28.627, longitude: 77.3727 },
  biasRadiusMeters: 50_000,
  countryCodes: ["in"],
  limit: 5,
};

const photonFeature = (properties: Record<string, unknown>, coordinates: unknown = [77.3643, 28.6211]) => ({
  type: "Feature",
  properties: { countrycode: "IN", ...properties },
  geometry: { type: "Point", coordinates },
});

describe("PhotonProvider", () => {
  const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>();
  const provider = new PhotonProvider(
    configOf({
      photonBaseUrl: "https://photon.example.test",
      photonMinIntervalMs: 0,
      placesTimeoutMs: 2_000,
    }),
  );

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it("searches around the rider, keeps one country and drops duplicate rows of one place", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        features: [
          photonFeature({
            osm_type: "N",
            osm_id: 108,
            name: "Sector 62",
            city: "Noida",
            state: "Uttar Pradesh",
            postcode: "201309",
          }),
          photonFeature({
            osm_type: "W",
            osm_id: 5,
            name: "Fortis Hospital",
            street: "Vishwakarma Road",
            district: "Sector 62",
            city: "Noida",
          }),
          // The same hospital mapped again as a relation: same label, dropped.
          photonFeature({
            osm_type: "R",
            osm_id: 6,
            name: "Fortis Hospital",
            street: "Vishwakarma Road",
            district: "Sector 62",
            city: "Noida",
          }),
          photonFeature({
            osm_type: "N",
            osm_id: 7,
            name: "Sector 62",
            city: "Lahore",
            countrycode: "PK",
          }),
          photonFeature({ osm_type: "N", osm_id: 8, name: "Broken" }, "not-coordinates"),
        ],
      }),
    );
    const results = await provider.autocomplete(noidaSearch);
    expect(results).toEqual([
      {
        id: "osm:N108",
        name: "Sector 62",
        secondaryText: "Noida, Uttar Pradesh",
        address: "Sector 62, Noida, Uttar Pradesh",
        latitude: 28.6211,
        longitude: 77.3643,
      },
      {
        id: "osm:W5",
        name: "Fortis Hospital",
        secondaryText: "Vishwakarma Road, Sector 62, Noida",
        address: "Fortis Hospital, Vishwakarma Road, Sector 62, Noida",
        latitude: 28.6211,
        longitude: 77.3643,
      },
    ]);
    const [url, init] = fetchMock.mock.calls[0];
    const params = new URL(url).searchParams;
    expect(url.startsWith("https://photon.example.test/api/?")).toBe(true);
    expect(params.get("q")).toBe("sector 62");
    expect(params.get("lat")).toBe("28.62700");
    expect(params.get("lon")).toBe("77.37270");
    expect(params.get("lang")).toBe("en");
    expect(Number(params.get("limit"))).toBeGreaterThan(noidaSearch.limit);
    expect((init.headers as Record<string, string>)["User-Agent"]).toContain("TirvonaRides");
  });

  it("names an unnamed address from its house number and street", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        features: [
          photonFeature({
            osm_type: "N",
            osm_id: 1,
            housenumber: "C-56",
            street: "Sector 62 Road",
            city: "Noida",
          }),
        ],
      }),
    );
    const [result] = await provider.autocomplete(noidaSearch);
    expect(result).toMatchObject({
      id: "osm:N1",
      name: "C-56 Sector 62 Road",
      secondaryText: "Noida",
    });
  });

  it("reverse-geocodes to the rider's exact point, and null when nothing is near", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        features: [
          photonFeature({
            osm_type: "W",
            osm_id: 9,
            name: "Fortis Hospital",
            district: "Sector 62",
            city: "Noida",
          }),
        ],
      }),
    );
    await expect(provider.reverse({ latitude: 28.618, longitude: 77.3726 })).resolves.toEqual({
      id: "osm:W9",
      name: "Fortis Hospital",
      address: "Fortis Hospital, Sector 62, Noida",
      latitude: 28.618,
      longitude: 77.3726,
    });
    expect(new URL(fetchMock.mock.calls[0][0]).pathname).toBe("/reverse");
    fetchMock.mockResolvedValueOnce(jsonResponse({ features: [] }));
    await expect(provider.reverse({ latitude: 0, longitude: 0 })).resolves.toBeNull();
  });

  it("has no lookup endpoint, so resolve answers null without a call", async () => {
    await expect(provider.resolve()).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps HTTP, parse and network failures to GeocodingProviderError", async () => {
    fetchMock.mockResolvedValueOnce(new Response("busy", { status: 503 }));
    await expect(provider.autocomplete(noidaSearch)).rejects.toMatchObject({
      retryable: true,
    });
    fetchMock.mockResolvedValueOnce(new Response("bad", { status: 400 }));
    await expect(provider.autocomplete(noidaSearch)).rejects.toMatchObject({
      retryable: false,
    });
    fetchMock.mockResolvedValueOnce(new Response("<html>", { status: 200 }));
    await expect(provider.autocomplete(noidaSearch)).rejects.toThrow("malformed JSON");
    fetchMock.mockRejectedValueOnce(new Error("ETIMEDOUT"));
    await expect(provider.autocomplete(noidaSearch)).rejects.toBeInstanceOf(GeocodingProviderError);
  });
});

describe("RequestSpacer", () => {
  it("spaces calls and refuses a caller that would wait too long", async () => {
    const spacer = new RequestSpacer("Photon", 50, 60);
    const started = Date.now();
    await spacer.acquire();
    await spacer.acquire();
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
    // The next free slot is ~50 ms out; a third immediate caller would wait ~100 ms.
    const pending = spacer.acquire();
    await expect(spacer.acquire()).rejects.toThrow("Photon request budget exhausted");
    await pending;
  });

  it("never waits when spacing is off (self-hosted)", async () => {
    const spacer = new RequestSpacer("Photon", 0, 0);
    await Promise.all([spacer.acquire(), spacer.acquire(), spacer.acquire()]);
  });
});

class StubProvider extends GeocodingProvider {
  readonly isConfigured = true;
  readonly calls: string[] = [];

  constructor(
    readonly name: string,
    private readonly answer: { error?: Error; placeName?: string },
  ) {
    super();
  }

  autocomplete() {
    const name = this.answer.placeName;
    return this.respond("autocomplete", name ? [{ id: "osm:N1", name, secondaryText: "", address: name }] : []);
  }

  resolve() {
    return this.respond("resolve", this.place());
  }

  reverse() {
    return this.respond("reverse", this.place());
  }

  private place() {
    const name = this.answer.placeName;
    return name ? { id: "osm:N1", name, address: name, latitude: 1, longitude: 2 } : null;
  }

  private respond<T>(operation: string, value: T): Promise<T> {
    this.calls.push(operation);
    return this.answer.error ? Promise.reject(this.answer.error) : Promise.resolve(value);
  }
}

describe("FallbackGeocodingProvider", () => {
  const point = { latitude: 1, longitude: 2 };
  const down = () =>
    new StubProvider("photon", {
      error: new GeocodingProviderError("Photon 503", true),
    });
  const backup = () => new StubProvider("nominatim", { placeName: "Backup" });

  it("answers from the primary without touching the secondary", async () => {
    const secondary = backup();
    const provider = new FallbackGeocodingProvider(new StubProvider("photon", { placeName: "Primary" }), secondary);
    expect(provider.name).toBe("photon+nominatim");
    expect((await provider.autocomplete(noidaSearch))[0].name).toBe("Primary");
    expect((await provider.resolve("osm:N1"))?.name).toBe("Primary");
    expect((await provider.reverse(point))?.name).toBe("Primary");
    expect(secondary.calls).toEqual([]);
  });

  it("falls back on every operation when the primary fails", async () => {
    const provider = new FallbackGeocodingProvider(down(), backup());
    expect((await provider.autocomplete(noidaSearch))[0].name).toBe("Backup");
    expect((await provider.resolve("osm:N1"))?.name).toBe("Backup");
    expect((await provider.reverse(point))?.name).toBe("Backup");
  });

  it("asks the secondary when the primary cannot resolve or name a spot, but not after an empty search", async () => {
    const secondary = backup();
    const provider = new FallbackGeocodingProvider(new StubProvider("photon", {}), secondary);
    expect(await provider.autocomplete(noidaSearch)).toEqual([]);
    expect((await provider.resolve("osm:N1"))?.name).toBe("Backup");
    expect((await provider.reverse(point))?.name).toBe("Backup");
    expect(secondary.calls).toEqual(["resolve", "reverse"]);
  });

  it("surfaces the secondary's error when both fail", async () => {
    const provider = new FallbackGeocodingProvider(
      down(),
      new StubProvider("nominatim", {
        error: new GeocodingProviderError("Nominatim 429", true),
      }),
    );
    await expect(provider.autocomplete(noidaSearch)).rejects.toThrow("Nominatim 429");
  });
});
