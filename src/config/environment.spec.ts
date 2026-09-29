import { environment, environmentFrom as environment_, validateEnvironment } from "./environment";

const productionInput = (): Record<string, unknown> => ({
  NODE_ENV: "production",
  MONGODB_URI: "mongodb://db.internal:27017",
  REDIS_URL: "redis://cache.internal:6379",
  CORS_ORIGINS: "https://ride-admin.tirvona.com",
  JWT_ACCESS_SECRET: "a".repeat(32),
  JWT_REFRESH_SECRET: "b".repeat(32),
  RAZORPAY_KEY_ID: "rzp_live_AbCdEf123456",
  RAZORPAY_KEY_SECRET: "live-secret-value",
  RAZORPAY_WEBHOOK_SECRET: "webhook-secret-value",
  PUBLIC_BASE_URL: "https://ride-api.tirvona.com",
});

describe("validateEnvironment", () => {
  it("accepts an empty development environment", () => {
    expect(() => validateEnvironment({})).not.toThrow();
  });

  it("rejects an unknown NODE_ENV", () => {
    expect(() => validateEnvironment({ NODE_ENV: "staging" })).toThrow(
      "NODE_ENV",
    );
  });

  it("rejects non-positive integers", () => {
    expect(() => validateEnvironment({ PORT: "0" })).toThrow("PORT");
    expect(() => validateEnvironment({ THROTTLE_LIMIT: "abc" })).toThrow(
      "THROTTLE_LIMIT",
    );
  });

  it("rejects malformed connection URLs", () => {
    expect(() =>
      validateEnvironment({ MONGODB_URI: "http://localhost:27017" }),
    ).toThrow("MONGODB_URI");
    expect(() => validateEnvironment({ REDIS_URL: "localhost:6379" })).toThrow(
      "REDIS_URL",
    );
  });

  it("rejects non-HTTP CORS origins", () => {
    expect(() => validateEnvironment({ CORS_ORIGINS: "ftp://x.com" })).toThrow(
      "CORS_ORIGINS",
    );
  });

  it("does not require Redis in production (Phase 3 is MongoDB-only)", () => {
    const input = productionInput();
    delete input.REDIS_URL;
    expect(() => validateEnvironment(input)).not.toThrow();
  });

  it("requires the location stale window to cover two persist intervals", () => {
    expect(() =>
      validateEnvironment({
        DRIVER_LOCATION_STALE_SECONDS: "20",
        DRIVER_LOCATION_PERSIST_INTERVAL_SECONDS: "15",
      }),
    ).toThrow("DRIVER_LOCATION_STALE_SECONDS");
  });

  it("still honours the Phase 2 heartbeat name as the stale window", () => {
    expect(
      environment_({ MATCHING_DRIVER_HEARTBEAT_SECONDS: "90" }).driverLocationStaleSeconds,
    ).toBe(90);
  });

  it("accepts a complete production environment", () => {
    expect(() => validateEnvironment(productionInput())).not.toThrow();
  });

  it.each(["MONGODB_URI", "CORS_ORIGINS", "JWT_ACCESS_SECRET"])(
    "requires %s in production",
    (name) => {
      const input = productionInput();
      delete input[name];
      expect(() => validateEnvironment(input)).toThrow(name);
    },
  );

  it("rejects short or reused JWT secrets in production", () => {
    expect(() =>
      validateEnvironment({ ...productionInput(), JWT_ACCESS_SECRET: "short" }),
    ).toThrow("at least 32");
    expect(() =>
      validateEnvironment({
        ...productionInput(),
        JWT_REFRESH_SECRET: "a".repeat(32),
      }),
    ).toThrow("must differ");
  });

  it.each(["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET"])(
    "requires %s in production",
    (name) => {
      const input = productionInput();
      delete input[name];
      expect(() => validateEnvironment(input)).toThrow("RAZORPAY_");
    },
  );

  it("allows production without Razorpay only when PAYMENTS_ENABLED=false", () => {
    const input = productionInput();
    delete input.RAZORPAY_KEY_ID;
    delete input.RAZORPAY_KEY_SECRET;
    delete input.RAZORPAY_WEBHOOK_SECRET;
    expect(() => validateEnvironment(input)).toThrow("RAZORPAY_KEY_ID");
    expect(() => validateEnvironment({ ...input, PAYMENTS_ENABLED: "true" })).toThrow("RAZORPAY_KEY_ID");
    expect(() => validateEnvironment({ ...input, PAYMENTS_ENABLED: "false" })).not.toThrow();
  });

  it("never accepts live Razorpay keys outside production", () => {
    expect(() =>
      validateEnvironment({ RAZORPAY_KEY_ID: "rzp_live_AbCdEf123456", RAZORPAY_KEY_SECRET: "x" }),
    ).toThrow("only allowed when NODE_ENV=production");
    expect(() =>
      validateEnvironment({ RAZORPAY_KEY_ID: "rzp_test_AbCdEf123456", RAZORPAY_KEY_SECRET: "x" }),
    ).not.toThrow();
  });

  it("requires the Razorpay key id and secret together", () => {
    expect(() => validateEnvironment({ RAZORPAY_KEY_ID: "rzp_test_AbCdEf123456" })).toThrow("set together");
    expect(() => validateEnvironment({ RAZORPAY_KEY_ID: "pk_test_1", RAZORPAY_KEY_SECRET: "x" })).toThrow(
      "rzp_test_",
    );
  });

  it("bounds the default commission and the earnings hold window", () => {
    expect(() => validateEnvironment({ DEFAULT_COMMISSION_PERCENT: "120" })).toThrow("between 0 and 100");
    expect(() => validateEnvironment({ EARNINGS_HOLD_HOURS: "-1" })).toThrow("EARNINGS_HOLD_HOURS");
    expect(() => validateEnvironment({ DEFAULT_COMMISSION_PERCENT: "17.5", EARNINGS_HOLD_HOURS: "24" })).not.toThrow();
  });

  it("validates the final-fare and refund/reconciliation settings", () => {
    expect(() => validateEnvironment({ FINAL_FARE_MODE: "estimate" })).toThrow("FINAL_FARE_MODE");
    expect(() => validateEnvironment({ FINAL_FARE_MAX_ESTIMATE_MULTIPLIER: "0.8" })).toThrow("FINAL_FARE_MAX_ESTIMATE_MULTIPLIER");
    expect(() => validateEnvironment({ PAYMENT_DAILY_RECONCILIATION_HOUR: "24" })).toThrow("PAYMENT_DAILY_RECONCILIATION_HOUR");
    expect(() => validateEnvironment({ PAYMENT_REFUND_WINDOW_DAYS: "0" })).toThrow("PAYMENT_REFUND_WINDOW_DAYS");
    expect(() =>
      validateEnvironment({
        FINAL_FARE_MODE: "BOOKED",
        FINAL_FARE_MAX_ESTIMATE_MULTIPLIER: "0",
        PAYMENT_DAILY_RECONCILIATION_HOUR: "2",
        PAYMENT_REFUND_WINDOW_DAYS: "180",
      }),
    ).not.toThrow();
    process.env = { FINAL_FARE_MODE: "Booked" };
    expect(environment()).toMatchObject({ finalFareMode: "booked", finalFareMaxEstimateMultiplier: 1.5, tripMeterMaxGapSeconds: 120 });
  });

  it("requires an HTTPS public base URL in production (share links)", () => {
    const input = productionInput();
    delete input.PUBLIC_BASE_URL;
    expect(() => validateEnvironment(input)).toThrow("PUBLIC_BASE_URL is required");
    expect(() => validateEnvironment({ ...productionInput(), PUBLIC_BASE_URL: "http://ride-api.tirvona.com" })).toThrow(
      "HTTPS",
    );
    expect(() => validateEnvironment({ PUBLIC_BASE_URL: "not a url" })).toThrow("valid HTTP(S) URL");
  });

  it("requires the Firebase service account all-or-nothing", () => {
    expect(() => validateEnvironment({ FIREBASE_PROJECT_ID: "tirvona" })).toThrow("set together");
    expect(() =>
      validateEnvironment({
        FIREBASE_PROJECT_ID: "tirvona",
        FIREBASE_CLIENT_EMAIL: "push@tirvona.iam.gserviceaccount.com",
        FIREBASE_PRIVATE_KEY: "not-a-key",
      }),
    ).toThrow("PEM");
    expect(() => validateEnvironment({ FIREBASE_SERVICE_ACCOUNT_BASE64: "%%%" })).toThrow("base64");
    const account = Buffer.from(
      JSON.stringify({
        project_id: "tirvona",
        client_email: "push@tirvona.iam.gserviceaccount.com",
        private_key: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n",
      }),
    ).toString("base64");
    expect(() => validateEnvironment({ FIREBASE_SERVICE_ACCOUNT_BASE64: account })).not.toThrow();
    const config = environment_({ FIREBASE_SERVICE_ACCOUNT_BASE64: account });
    expect(config.firebaseProjectId).toBe("tirvona");
    expect(config.firebasePrivateKey).toContain("\n");
  });

  it("rejects wildcard CORS in production", () => {
    expect(() =>
      validateEnvironment({
        ...productionInput(),
        CORS_ORIGINS: "https://*.tirvona.com",
      }),
    ).toThrow("Wildcard");
  });

  it("validates place-search settings", () => {
    expect(() => validateEnvironment({ PLACES_PROVIDER: "mapquest" })).toThrow("PLACES_PROVIDER");
    expect(() => validateEnvironment({ PLACES_PROVIDER: "google" })).toThrow("GOOGLE_MAPS_API_KEY");
    expect(() => validateEnvironment({ PLACES_PROVIDER: "google", GOOGLE_MAPS_API_KEY: "key" })).not.toThrow();
    expect(() => validateEnvironment({ PLACES_COUNTRY_CODES: "india" })).toThrow("PLACES_COUNTRY_CODES");
    expect(() => validateEnvironment({ PLACES_BIAS_LATITUDE: "95" })).toThrow("PLACES_BIAS_LATITUDE");
    expect(() => validateEnvironment({ NOMINATIM_BASE_URL: "nominatim" })).toThrow("NOMINATIM_BASE_URL");
    expect(() => validateEnvironment({ NOMINATIM_MIN_INTERVAL_MS: "0" })).not.toThrow();
    expect(() => validateEnvironment({ PLACES_PROVIDER: "photon" })).not.toThrow();
    expect(() => validateEnvironment({ PHOTON_BASE_URL: "photon" })).toThrow("PHOTON_BASE_URL");
    expect(() => validateEnvironment({ PHOTON_MIN_INTERVAL_MS: "-5" })).toThrow("PHOTON_MIN_INTERVAL_MS");
    expect(() => validateEnvironment({ PLACES_FEATURED_RADIUS_KM: "0" })).toThrow("PLACES_FEATURED_RADIUS_KM");
  });

  it("falls back from Google Places to OSM by default, and validates the fallback", () => {
    expect(environment_({ GOOGLE_MAPS_API_KEY: "key" })).toMatchObject({
      placesProvider: "google",
      placesFallback: "osm",
      placesFailureThreshold: 3,
      placesFailureCooldownSeconds: 60,
    });
    expect(environment_({ PLACES_FALLBACK: "NONE" }).placesFallback).toBe("none");
    expect(() => validateEnvironment({ PLACES_FALLBACK: "bing" })).toThrow("PLACES_FALLBACK");
    expect(() => validateEnvironment({ PLACES_FAILURE_THRESHOLD: "0" })).toThrow("PLACES_FAILURE_THRESHOLD");
  });

  it("picks Google Routes only when its key is set, and validates routing options", () => {
    expect(environment_({}).routesProvider).toBe("haversine");
    expect(environment_({ GOOGLE_ROUTES_API_KEY: " key " })).toMatchObject({
      routesProvider: "google",
      googleRoutesApiKey: "key",
      routesTravelMode: "DRIVE",
      routesTrafficAware: false,
    });
    expect(environment_({ GOOGLE_ROUTES_API_KEY: "key", ROUTES_PROVIDER: "haversine" }).routesProvider).toBe(
      "haversine",
    );
    expect(() => validateEnvironment({ ROUTES_PROVIDER: "osrm" })).toThrow("ROUTES_PROVIDER");
    expect(() => validateEnvironment({ ROUTES_PROVIDER: "google" })).toThrow("GOOGLE_ROUTES_API_KEY");
    expect(() => validateEnvironment({ ROUTES_PROVIDER: "google", GOOGLE_ROUTES_API_KEY: "key" })).not.toThrow();
    expect(() => validateEnvironment({ ROUTES_TRAVEL_MODE: "walk" })).toThrow("ROUTES_TRAVEL_MODE");
    expect(() => validateEnvironment({ ROUTES_TRAVEL_MODE: "two_wheeler" })).not.toThrow();
    expect(() => validateEnvironment({ ROUTES_TIMEOUT_MS: "0" })).toThrow("ROUTES_TIMEOUT_MS");
    expect(() => validateEnvironment({ ROUTES_LIVE_REFRESH_METERS: "-1" })).toThrow("ROUTES_LIVE_REFRESH_METERS");
  });
});

describe("environment", () => {
  const original = process.env;
  afterEach(() => {
    process.env = original;
  });

  it("uses local-development defaults", () => {
    process.env = {};
    const config = environment();
    expect(config.port).toBe(5100);
    expect(config.mongoDbName).toBe("tirvona_ride");
    expect(config.redisUrl).toBe("");
    expect(config.swaggerEnabled).toBe(true);
    expect(config.placesProvider).toBe("osm");
    expect(config.photonBaseUrl).toBe("https://photon.komoot.io");
    expect(config.placesCountryCodes).toEqual(["in"]);
  });

  it("picks Google place search when a Maps key is present", () => {
    process.env = { GOOGLE_MAPS_API_KEY: "key" };
    expect(environment().placesProvider).toBe("google");
  });

  it("disables Swagger by default in production", () => {
    process.env = { NODE_ENV: "production" };
    expect(environment().swaggerEnabled).toBe(false);
  });
});
