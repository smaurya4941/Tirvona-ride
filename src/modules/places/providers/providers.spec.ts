import type { ConfigService } from "@nestjs/config";
import { GeocodingProviderError } from "./geocoding.provider";
import { GooglePlacesProvider } from "./google-places.provider";
import { NominatimProvider } from "./nominatim.provider";

const configOf = (settings: Record<string, unknown>) =>
  ({
    get: (key: string) => settings[key],
    getOrThrow: (key: string) => {
      if (!(key in settings)) throw new Error(`missing ${key}`);
      return settings[key];
    },
  }) as unknown as ConfigService;

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const realFetch = global.fetch;
afterAll(() => {
  global.fetch = realFetch;
});

const searchRequest = {
  query: "Govind Dev",
  bias: { latitude: 27.5406, longitude: 77.6708 },
  biasRadiusMeters: 50_000,
  countryCodes: ["in"],
  limit: 5,
};

describe("NominatimProvider", () => {
  const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>();
  const provider = new NominatimProvider(
    configOf({
      nominatimBaseUrl: "https://nominatim.example.test",
      nominatimContactEmail: "ops@tirvona.test",
      nominatimMinIntervalMs: 0,
      placesTimeoutMs: 2_000,
    }),
  );

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it("searches with a service-area viewbox, country filter and identifying headers", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        {
          osm_type: "way",
          osm_id: 4242,
          lat: "27.5795",
          lon: "77.6991",
          name: "Govind Dev Temple",
          display_name: "Govind Dev Temple, Gopinath Bazar, Vrindavan, Mathura, Uttar Pradesh, 281121, India",
        },
        { osm_type: "node", osm_id: 1, lat: "not-a-number", lon: "77", display_name: "Broken" },
      ]),
    );
    const results = await provider.autocomplete(searchRequest);
    expect(results).toEqual([
      {
        id: "osm:W4242",
        name: "Govind Dev Temple",
        secondaryText: "Gopinath Bazar, Vrindavan, Mathura, Uttar Pradesh",
        address: "Govind Dev Temple, Gopinath Bazar, Vrindavan, Mathura, Uttar Pradesh",
        latitude: 27.5795,
        longitude: 77.6991,
      },
    ]);
    const [url, init] = fetchMock.mock.calls[0];
    const params = new URL(url).searchParams;
    expect(url.startsWith("https://nominatim.example.test/search?")).toBe(true);
    expect(params.get("q")).toBe("Govind Dev");
    expect(params.get("countrycodes")).toBe("in");
    expect(params.get("bounded")).toBe("0");
    expect(params.get("viewbox")?.split(",")).toHaveLength(4);
    expect(params.get("email")).toBe("ops@tirvona.test");
    expect((init.headers as Record<string, string>)["User-Agent"]).toContain("TirvonaRides");
  });

  it("resolves osm ids through /lookup and rejects foreign ids without a call", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([{ osm_type: "node", osm_id: 7, lat: "27.5", lon: "77.6", name: "Ghat", display_name: "Ghat, Mathura, India" }]),
    );
    await expect(provider.resolve("osm:N7")).resolves.toEqual({
      id: "osm:N7",
      name: "Ghat",
      address: "Ghat, Mathura",
      latitude: 27.5,
      longitude: 77.6,
    });
    expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get("osm_ids")).toBe("N7");
    await expect(provider.resolve("google:abcdefghijk")).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reverse-geocodes to the rider's exact point, and null when nothing is there", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ osm_type: "way", osm_id: 9, lat: "27.58", lon: "77.69", display_name: "Loi Bazar, Vrindavan, India" }),
    );
    await expect(provider.reverse({ latitude: 27.5812, longitude: 77.6934 })).resolves.toMatchObject({
      name: "Loi Bazar",
      address: "Loi Bazar, Vrindavan",
      latitude: 27.5812,
      longitude: 77.6934,
    });
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "Unable to geocode" }));
    await expect(provider.reverse({ latitude: 0, longitude: 0 })).resolves.toBeNull();
  });

  it("maps HTTP and network failures to GeocodingProviderError", async () => {
    fetchMock.mockResolvedValueOnce(new Response("slow down", { status: 429 }));
    await expect(provider.autocomplete(searchRequest)).rejects.toMatchObject({ retryable: true });
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 403 }));
    await expect(provider.autocomplete(searchRequest)).rejects.toMatchObject({ retryable: false });
    fetchMock.mockRejectedValueOnce(new Error("ECONNRESET"));
    await expect(provider.autocomplete(searchRequest)).rejects.toBeInstanceOf(GeocodingProviderError);
  });

  it("spaces calls and refuses instead of queueing riders for seconds", async () => {
    const spaced = new NominatimProvider(
      configOf({
        nominatimBaseUrl: "https://nominatim.example.test",
        nominatimContactEmail: "ops@tirvona.test",
        nominatimMinIntervalMs: 1_000,
        placesTimeoutMs: 1_500,
      }),
    );
    fetchMock.mockImplementation(async () => jsonResponse([]));
    const first = spaced.autocomplete(searchRequest);
    const second = spaced.autocomplete(searchRequest);
    const third = spaced.autocomplete(searchRequest);
    await expect(first).resolves.toEqual([]);
    await expect(third).rejects.toThrow("budget exhausted");
    await expect(second).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("GooglePlacesProvider", () => {
  const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>();
  const provider = new GooglePlacesProvider(configOf({ googleMapsApiKey: "test-key", placesTimeoutMs: 2_000 }));

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it("autocompletes with the key in a header, a capped bias circle and the session token", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        suggestions: [
          {
            placePrediction: {
              placeId: "ChIJ-govind-dev-01",
              text: { text: "Govind Dev Ji Temple, Vrindavan, Uttar Pradesh, India" },
              structuredFormat: {
                mainText: { text: "Govind Dev Ji Temple" },
                secondaryText: { text: "Vrindavan, Uttar Pradesh, India" },
              },
              distanceMeters: 4200,
            },
          },
          { queryPrediction: { text: { text: "govind dev" } } },
        ],
      }),
    );
    const results = await provider.autocomplete({ ...searchRequest, biasRadiusMeters: 80_000, sessionToken: "session-1234" });
    expect(results).toEqual([
      {
        id: "google:ChIJ-govind-dev-01",
        name: "Govind Dev Ji Temple",
        secondaryText: "Vrindavan, Uttar Pradesh",
        address: "Govind Dev Ji Temple, Vrindavan, Uttar Pradesh",
        distanceMeters: 4200,
      },
    ]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://places.googleapis.com/v1/places:autocomplete");
    expect((init.headers as Record<string, string>)["X-Goog-Api-Key"]).toBe("test-key");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ input: "Govind Dev", sessionToken: "session-1234", includedRegionCodes: ["in"] });
    expect(body.locationBias.circle.radius).toBe(50_000);
  });

  it("resolves details with a field mask, and null for unknown places", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        id: "ChIJ-govind-dev-01",
        displayName: { text: "Govind Dev Ji Temple" },
        formattedAddress: "Govind Dev Ji Temple, Goda Vihar, Vrindavan, Uttar Pradesh 281121, India",
        location: { latitude: 27.5791, longitude: 77.6993 },
      }),
    );
    await expect(provider.resolve("google:ChIJ-govind-dev-01", "session-1234")).resolves.toEqual({
      id: "google:ChIJ-govind-dev-01",
      name: "Govind Dev Ji Temple",
      address: "Govind Dev Ji Temple, Goda Vihar, Vrindavan, Uttar Pradesh 281121",
      latitude: 27.5791,
      longitude: 77.6993,
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/places/ChIJ-govind-dev-01?");
    expect(new URL(url).searchParams.get("sessionToken")).toBe("session-1234");
    expect((init.headers as Record<string, string>)["X-Goog-FieldMask"]).toContain("location");

    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { status: "NOT_FOUND" } }, 404));
    await expect(provider.resolve("google:ChIJ-missing-000")).resolves.toBeNull();
  });

  it("reverse-geocodes through the Geocoding API and surfaces quota errors", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        status: "OK",
        results: [{ place_id: "ChIJ-pin-000001", formatted_address: "Parikrama Marg, Vrindavan, Uttar Pradesh 281121, India" }],
      }),
    );
    await expect(provider.reverse({ latitude: 27.58, longitude: 77.7 })).resolves.toMatchObject({
      name: "Parikrama Marg",
      address: "Parikrama Marg, Vrindavan, Uttar Pradesh 281121",
      latitude: 27.58,
      longitude: 77.7,
    });
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: "ZERO_RESULTS", results: [] }));
    await expect(provider.reverse({ latitude: 0, longitude: 0 })).resolves.toBeNull();
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: "OVER_QUERY_LIMIT" }));
    await expect(provider.reverse({ latitude: 1, longitude: 1 })).rejects.toMatchObject({ retryable: true });
  });
});
