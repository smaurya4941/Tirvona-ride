import type { ConfigService } from "@nestjs/config";
import { GOOGLE_ROUTES_URL, GoogleRoutesEstimator, parseDurationSeconds } from "./google-routes-estimator";
import { LiveRouteService } from "./live-route.service";
import type { LocationsService } from "./locations.service";
import { ResilientRouteEstimator } from "./resilient-route-estimator";
import { NoRouteFoundError, RouteProviderError } from "./route-estimator";
import type { RouteEstimate, RouteEstimator } from "./route-estimator";

const VRINDAVAN = { latitude: 27.5806, longitude: 77.7006 };
const MATHURA = { latitude: 27.4924, longitude: 77.6737 };

const configOf = (values: Record<string, unknown>) =>
  ({
    get: (key: string) => values[key],
    getOrThrow: (key: string) => {
      if (!(key in values)) throw new Error(`missing ${key}`);
      return values[key];
    },
  }) as unknown as ConfigService;

const googleConfig = (overrides: Record<string, unknown> = {}) =>
  configOf({
    googleRoutesApiKey: "test-key",
    routesTimeoutMs: 1_000,
    routesTrafficAware: false,
    routesTravelMode: "DRIVE",
    ...overrides,
  });

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("parseDurationSeconds", () => {
  it("reads protobuf JSON durations", () => {
    expect(parseDurationSeconds("1234s")).toBe(1234);
    expect(parseDurationSeconds("12.6s")).toBe(13);
    expect(parseDurationSeconds("0s")).toBe(0);
  });

  it("rejects anything else", () => {
    expect(parseDurationSeconds(undefined)).toBeUndefined();
    expect(parseDurationSeconds("12 min")).toBeUndefined();
  });
});

describe("GoogleRoutesEstimator", () => {
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    fetchMock = jest.spyOn(global, "fetch");
  });

  afterEach(() => fetchMock.mockRestore());

  it("asks computeRoutes for distance, duration and polyline only, with the key in a header", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        routes: [{ distanceMeters: 11_873, duration: "1512s", polyline: { encodedPolyline: "_p~iF~ps|U_ulLnnqC" } }],
      }),
    );

    const route = await new GoogleRoutesEstimator(googleConfig()).estimate(VRINDAVAN, MATHURA);

    expect(route).toEqual({
      distanceMeters: 11_873,
      durationSeconds: 1512,
      provider: "GOOGLE_ROUTES",
      polyline: "_p~iF~ps|U_ulLnnqC",
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(GOOGLE_ROUTES_URL);
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Goog-Api-Key"]).toBe("test-key");
    expect(headers["X-Goog-FieldMask"]).toBe(
      "routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline",
    );
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      origin: { location: { latLng: VRINDAVAN } },
      destination: { location: { latLng: MATHURA } },
      travelMode: "DRIVE",
      routingPreference: "TRAFFIC_UNAWARE",
      computeAlternativeRoutes: false,
      regionCode: "IN",
    });
    expect(url).not.toContain("test-key");
  });

  it("uses live traffic and the configured travel mode when asked", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { routes: [{ distanceMeters: 5, duration: "60s" }] }));
    await new GoogleRoutesEstimator(
      googleConfig({ routesTrafficAware: true, routesTravelMode: "TWO_WHEELER" }),
    ).estimate(VRINDAVAN, MATHURA);
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)) as Record<
      string,
      unknown
    >;
    expect(body.routingPreference).toBe("TRAFFIC_AWARE");
    expect(body.travelMode).toBe("TWO_WHEELER");
  });

  it("treats an empty answer as no route, and a missing distance as 0 m", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));
    await expect(new GoogleRoutesEstimator(googleConfig()).estimate(VRINDAVAN, MATHURA)).rejects.toBeInstanceOf(
      NoRouteFoundError,
    );

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { routes: [{ duration: "0s" }] }));
    const route = await new GoogleRoutesEstimator(googleConfig()).estimate(VRINDAVAN, VRINDAVAN);
    expect(route.distanceMeters).toBe(0);
    expect(route.polyline).toBeUndefined();
  });

  it("classifies failures: 403 is permanent, 429/5xx and network errors are retryable", async () => {
    const estimator = new GoogleRoutesEstimator(googleConfig());

    fetchMock.mockResolvedValueOnce(
      jsonResponse(403, { error: { status: "PERMISSION_DENIED", message: "API key not authorized" } }),
    );
    const denied = await estimator.estimate(VRINDAVAN, MATHURA).catch((error: unknown) => error);
    expect(denied).toBeInstanceOf(RouteProviderError);
    expect((denied as RouteProviderError).retryable).toBe(false);
    expect((denied as Error).message).toContain("PERMISSION_DENIED");

    fetchMock.mockResolvedValueOnce(jsonResponse(503, {}));
    expect(((await estimator.estimate(VRINDAVAN, MATHURA).catch((e: unknown) => e)) as RouteProviderError).retryable).toBe(
      true,
    );

    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect(((await estimator.estimate(VRINDAVAN, MATHURA).catch((e: unknown) => e)) as RouteProviderError).retryable).toBe(
      true,
    );
  });

  it("refuses to call Google without a key", async () => {
    await expect(
      new GoogleRoutesEstimator(googleConfig({ googleRoutesApiKey: "" })).estimate(VRINDAVAN, MATHURA),
    ).rejects.toThrow("GOOGLE_ROUTES_API_KEY");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("ResilientRouteEstimator", () => {
  const road: RouteEstimate = { distanceMeters: 12_000, durationSeconds: 1_500, provider: "GOOGLE_ROUTES", polyline: "abc" };
  const straight: RouteEstimate = { distanceMeters: 9_900, durationSeconds: 1_620, provider: "HAVERSINE" };

  let clock: number;
  let primary: jest.Mocked<RouteEstimator>;
  let fallback: jest.Mocked<RouteEstimator>;
  let estimator: ResilientRouteEstimator;

  beforeEach(() => {
    clock = 1_000_000;
    primary = { estimate: jest.fn().mockResolvedValue(road) };
    fallback = { estimate: jest.fn().mockResolvedValue(straight) };
    estimator = new ResilientRouteEstimator(primary, fallback, {
      cacheTtlMs: 60_000,
      cacheMaxEntries: 100,
      failureThreshold: 3,
      cooldownMs: 30_000,
      now: () => clock,
    });
  });

  it("caches a trip (points within ~11 m share it) and shares concurrent calls", async () => {
    const [a, b] = await Promise.all([
      estimator.estimate(VRINDAVAN, MATHURA),
      estimator.estimate(VRINDAVAN, MATHURA),
    ]);
    const nudged = await estimator.estimate(
      { latitude: VRINDAVAN.latitude + 0.00002, longitude: VRINDAVAN.longitude },
      MATHURA,
    );
    expect([a, b, nudged]).toEqual([road, road, road]);
    expect(primary.estimate).toHaveBeenCalledTimes(1);

    clock += 60_001;
    await estimator.estimate(VRINDAVAN, MATHURA);
    expect(primary.estimate).toHaveBeenCalledTimes(2);
  });

  it("falls back to the straight line on failure without caching it", async () => {
    primary.estimate.mockRejectedValueOnce(new RouteProviderError("timeout", true));
    expect(await estimator.estimate(VRINDAVAN, MATHURA)).toEqual(straight);
    expect(await estimator.estimate(VRINDAVAN, MATHURA)).toEqual(road);
    expect(primary.estimate).toHaveBeenCalledTimes(2);
  });

  it("skips the provider for the cooldown after repeated transient failures", async () => {
    primary.estimate.mockRejectedValue(new RouteProviderError("503", true));
    for (let i = 0; i < 3; i += 1) await estimator.estimate(VRINDAVAN, MATHURA);
    expect(estimator.isDegraded).toBe(true);

    await estimator.estimate(VRINDAVAN, MATHURA);
    expect(primary.estimate).toHaveBeenCalledTimes(3);

    clock += 30_001;
    primary.estimate.mockResolvedValue(road);
    expect(await estimator.estimate(VRINDAVAN, MATHURA)).toEqual(road);
    expect(estimator.isDegraded).toBe(false);
  });

  it("opens the breaker at once on a configuration error (bad key, API disabled)", async () => {
    primary.estimate.mockRejectedValueOnce(new RouteProviderError("403 PERMISSION_DENIED", false));
    await estimator.estimate(VRINDAVAN, MATHURA);
    expect(estimator.isDegraded).toBe(true);
  });

  it("does not count 'no route' against the provider's health", async () => {
    primary.estimate.mockRejectedValue(new NoRouteFoundError());
    for (let i = 0; i < 5; i += 1) expect(await estimator.estimate(VRINDAVAN, MATHURA)).toEqual(straight);
    expect(estimator.isDegraded).toBe(false);
  });

  it("resets the failure count after a success", async () => {
    primary.estimate
      .mockRejectedValueOnce(new RouteProviderError("x", true))
      .mockRejectedValueOnce(new RouteProviderError("x", true))
      .mockResolvedValueOnce(road)
      .mockRejectedValueOnce(new RouteProviderError("x", true));
    await estimator.estimate(VRINDAVAN, MATHURA);
    await estimator.estimate(VRINDAVAN, MATHURA);
    await estimator.estimate(VRINDAVAN, MATHURA);
    await estimator.estimate(MATHURA, VRINDAVAN);
    expect(estimator.isDegraded).toBe(false);
  });
});

describe("LiveRouteService", () => {
  const PICKUP = MATHURA;
  let routeBetween: jest.Mock;
  let service: LiveRouteService;

  beforeEach(() => {
    jest.useFakeTimers({ now: new Date("2026-09-28T10:00:00Z") });
    routeBetween = jest.fn().mockResolvedValue({ distanceMeters: 900, durationSeconds: 180, provider: "GOOGLE_ROUTES" });
    service = new LiveRouteService(
      { routeBetween } as unknown as LocationsService,
      configOf({ routesLiveRefreshSeconds: 90, routesLiveRefreshMeters: 300 }),
    );
  });

  afterEach(() => jest.useRealTimers());

  it("reuses the route while the driver stays close and it is recent", async () => {
    const first = await service.forRide("r1", "APPROACH", VRINDAVAN, PICKUP);
    // ~100 m further on, 60 s later: still fresh.
    jest.advanceTimersByTime(60_000);
    const again = await service.forRide(
      "r1",
      "APPROACH",
      { latitude: VRINDAVAN.latitude - 0.0009, longitude: VRINDAVAN.longitude },
      PICKUP,
    );
    expect(again).toBe(first);
    expect(routeBetween).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({ stage: "APPROACH", origin: VRINDAVAN, destination: PICKUP });
  });

  it("recomputes after the refresh interval, a long move, or a stage change", async () => {
    await service.forRide("r1", "APPROACH", VRINDAVAN, PICKUP);

    jest.advanceTimersByTime(90_001);
    await service.forRide("r1", "APPROACH", VRINDAVAN, PICKUP);
    expect(routeBetween).toHaveBeenCalledTimes(2);

    // ~450 m away.
    await service.forRide("r1", "APPROACH", { latitude: VRINDAVAN.latitude - 0.004, longitude: VRINDAVAN.longitude }, PICKUP);
    expect(routeBetween).toHaveBeenCalledTimes(3);

    await service.forRide("r1", "TRIP", { latitude: VRINDAVAN.latitude - 0.004, longitude: VRINDAVAN.longitude }, VRINDAVAN);
    expect(routeBetween).toHaveBeenCalledTimes(4);
  });

  it("shares one computation between concurrent polls of a ride", async () => {
    await Promise.all([
      service.forRide("r1", "APPROACH", VRINDAVAN, PICKUP),
      service.forRide("r1", "APPROACH", VRINDAVAN, PICKUP),
    ]);
    expect(routeBetween).toHaveBeenCalledTimes(1);
  });
});
