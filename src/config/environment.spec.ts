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
  });

  it("disables Swagger by default in production", () => {
    process.env = { NODE_ENV: "production" };
    expect(environment().swaggerEnabled).toBe(false);
  });
});
