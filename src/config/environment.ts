const NODE_ENVIRONMENTS = ["development", "test", "production"] as const;
export type NodeEnvironment = (typeof NODE_ENVIRONMENTS)[number];

const integer = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value ?? fallback);
  return Number.isInteger(parsed) ? parsed : fallback;
};

const decimal = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const boolean = (value: string | undefined, fallback: boolean): boolean =>
  value === undefined || value === ""
    ? fallback
    : value.toLowerCase() === "true";

const csv = (value: string | undefined, fallback: string): string[] =>
  (value || fallback)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

export interface Environment {
  nodeEnv: NodeEnvironment;
  serviceName: string;
  host: string;
  port: number;
  corsOrigins: string[];
  trustProxy: boolean;
  swaggerEnabled: boolean;
  logLevel: string;
  throttleTtlMs: number;
  throttleLimit: number;
  mongoUri: string;
  mongoDbName: string;
  mongoMinPoolSize: number;
  mongoMaxPoolSize: number;
  mongoServerSelectionTimeoutMs: number;
  mongoSocketTimeoutMs: number;
  redisUrl: string;
  redisKeyPrefix: string;
  jwtAccessSecret: string;
  jwtAccessExpiresIn: string;
  jwtRefreshSecret: string;
  jwtRefreshExpiresIn: string;
  jwtIssuer: string;
  jwtAudience: string;
  appTimeZone: string;
  routeAverageSpeedKmph: number;
  routeDistanceFactor: number;
  rideMinDistanceMeters: number;
  rideMaxDistanceKm: number;
  rideSearchTimeoutSeconds: number;
  rideAssignmentTimeoutSeconds: number;
  rideOtpTtlMinutes: number;
  rideOtpMaxAttempts: number;
  matchingRadiusKm: number;
  matchingSweepIntervalMs: number;
  matchingReactiveDispatch: boolean;
  realtimePingIntervalMs: number;
  realtimePingTimeoutMs: number;
  realtimeRecoveryWindowMs: number;
  driverLocationStaleSeconds: number;
  driverLocationPersistIntervalSeconds: number;
  driverLocationPersistDistanceMeters: number;
  driverLocationMinIntervalMs: number;
  driverLocationMaxAccuracyMeters: number;
  driverLocationMaxFixAgeSeconds: number;
  driverArrivingRadiusMeters: number;
  rideCheckpointIntervalSeconds: number;
  razorpayKeyId: string;
  razorpayKeySecret: string;
  razorpayWebhookSecret: string;
  razorpayApiBaseUrl: string;
  razorpayTimeoutMs: number;
  paymentBrandName: string;
  paymentOrderReuseMinutes: number;
  paymentReconcileIntervalMs: number;
  paymentProcessingStaleSeconds: number;
  defaultCommissionPercent: number;
  earningsHoldHours: number;
  publicBaseUrl: string;
  firebaseProjectId: string;
  firebaseClientEmail: string;
  firebasePrivateKey: string;
  fcmTimeoutMs: number;
  pushAndroidChannelId: string;
  deviceTokensMaxPerUser: number;
  ratingWindowDays: number;
  emergencyContactsMax: number;
  sosPostRideGraceMinutes: number;
  shareRideLinkBaseUrl: string;
  shareRideMaxHours: number;
  shareRideGraceMinutes: number;
}

type RawEnvironment = Record<string, string | undefined>;

interface FirebaseServiceAccount {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

/** Private keys pasted into a .env usually carry literal "\n" sequences. */
const pemFrom = (value: string | undefined): string => (value ?? "").replace(/\\n/g, "\n").trim();

/**
 * The FCM service account, from FIREBASE_SERVICE_ACCOUNT_BASE64 (the whole
 * downloaded JSON, base64-encoded — easiest for hosting dashboards) or from
 * the three FIREBASE_* variables.
 */
export function firebaseServiceAccountFrom(env: RawEnvironment): FirebaseServiceAccount {
  const encoded = (env.FIREBASE_SERVICE_ACCOUNT_BASE64 ?? "").trim();
  if (encoded) {
    const json = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as Record<string, string>;
    return {
      projectId: (json.project_id ?? "").trim(),
      clientEmail: (json.client_email ?? "").trim(),
      privateKey: pemFrom(json.private_key),
    };
  }
  return {
    projectId: (env.FIREBASE_PROJECT_ID ?? "").trim(),
    clientEmail: (env.FIREBASE_CLIENT_EMAIL ?? "").trim(),
    privateKey: pemFrom(env.FIREBASE_PRIVATE_KEY),
  };
}

const stripTrailingSlashes = (value: string): string => value.replace(/\/+$/, "");

export const environmentFrom = (env: RawEnvironment): Environment => ({
  nodeEnv: (env.NODE_ENV as NodeEnvironment) || "development",
  serviceName: "tirvona-ride-api",
  host: env.HOST || "0.0.0.0",
  port: integer(env.PORT, 5100),
  corsOrigins: csv(
    env.CORS_ORIGINS,
    "http://localhost:5180,http://127.0.0.1:5180",
  ),
  trustProxy: boolean(env.TRUST_PROXY, false),
  swaggerEnabled: boolean(
    env.SWAGGER_ENABLED,
    env.NODE_ENV !== "production",
  ),
  logLevel: env.LOG_LEVEL || "info",
  throttleTtlMs: integer(env.THROTTLE_TTL_MS, 60_000),
  throttleLimit: integer(env.THROTTLE_LIMIT, 120),
  mongoUri: env.MONGODB_URI || "mongodb://127.0.0.1:27017",
  mongoDbName: env.MONGODB_DB_NAME || "tirvona_ride",
  mongoMinPoolSize: integer(env.MONGODB_MIN_POOL_SIZE, 1),
  mongoMaxPoolSize: integer(env.MONGODB_MAX_POOL_SIZE, 20),
  mongoServerSelectionTimeoutMs: integer(
    env.MONGODB_SERVER_SELECTION_TIMEOUT_MS,
    10_000,
  ),
  mongoSocketTimeoutMs: integer(env.MONGODB_SOCKET_TIMEOUT_MS, 45_000),
  redisUrl: env.REDIS_URL || "",
  redisKeyPrefix: env.REDIS_KEY_PREFIX || "tirvona-ride:",
  jwtAccessSecret: env.JWT_ACCESS_SECRET || "",
  jwtAccessExpiresIn: env.JWT_ACCESS_EXPIRES_IN || "15m",
  jwtRefreshSecret: env.JWT_REFRESH_SECRET || "",
  jwtRefreshExpiresIn: env.JWT_REFRESH_EXPIRES_IN || "30d",
  jwtIssuer: env.JWT_ISSUER || "tirvona-ride-api",
  jwtAudience: env.JWT_AUDIENCE || "tirvona-ride-clients",
  // "Today" on driver dashboards and admin counts is a local business day.
  appTimeZone: env.APP_TIME_ZONE || "Asia/Kolkata",
  // Phase 2 routing is straight-line (Haversine) — see LocationsModule.
  routeAverageSpeedKmph: decimal(env.ROUTE_AVERAGE_SPEED_KMPH, 22),
  routeDistanceFactor: decimal(env.ROUTE_DISTANCE_FACTOR, 1),
  rideMinDistanceMeters: integer(env.RIDE_MIN_DISTANCE_METERS, 200),
  rideMaxDistanceKm: integer(env.RIDE_MAX_DISTANCE_KM, 80),
  rideSearchTimeoutSeconds: integer(
    env.RIDE_SEARCH_TIMEOUT_SECONDS,
    120,
  ),
  rideAssignmentTimeoutSeconds: integer(
    env.RIDE_ASSIGNMENT_TIMEOUT_SECONDS,
    30,
  ),
  rideOtpTtlMinutes: integer(env.RIDE_OTP_TTL_MINUTES, 15),
  rideOtpMaxAttempts: integer(env.RIDE_OTP_MAX_ATTEMPTS, 5),
  matchingRadiusKm: decimal(env.MATCHING_RADIUS_KM, 8),
  // 0 disables the background sweep (the e2e suite drives it explicitly).
  // Phase 3 keeps it only as a safety net behind the reactive dispatch below.
  matchingSweepIntervalMs: integer(
    env.MATCHING_SWEEP_INTERVAL_MS,
    5_000,
  ),
  // Precise per-ride timeout timers and "a driver just became free" re-matching.
  matchingReactiveDispatch: boolean(
    env.MATCHING_REACTIVE_DISPATCH,
    true,
  ),

  // ── Realtime (Phase 3) ────────────────────────────────────────────────
  realtimePingIntervalMs: integer(
    env.REALTIME_PING_INTERVAL_MS,
    20_000,
  ),
  realtimePingTimeoutMs: integer(env.REALTIME_PING_TIMEOUT_MS, 20_000),
  // Socket.IO connection-state recovery: a client that reconnects within
  // this window gets its rooms back and any missed (non-volatile) events.
  realtimeRecoveryWindowMs: integer(
    env.REALTIME_RECOVERY_WINDOW_MS,
    120_000,
  ),

  // ── Driver location (Phase 3) ─────────────────────────────────────────
  // A driver whose last location is older than this is not matchable.
  // MATCHING_DRIVER_HEARTBEAT_SECONDS is the Phase 2 name, still honoured.
  driverLocationStaleSeconds: integer(
    env.DRIVER_LOCATION_STALE_SECONDS ??
      env.MATCHING_DRIVER_HEARTBEAT_SECONDS,
    60,
  ),
  // Live GPS is relayed on every fix but written to MongoDB at most this often
  // (or sooner when the driver moved further than the distance below).
  driverLocationPersistIntervalSeconds: integer(
    env.DRIVER_LOCATION_PERSIST_INTERVAL_SECONDS,
    15,
  ),
  driverLocationPersistDistanceMeters: integer(
    env.DRIVER_LOCATION_PERSIST_DISTANCE_METERS,
    75,
  ),
  // Server-side floor between accepted fixes from one driver.
  driverLocationMinIntervalMs: integer(
    env.DRIVER_LOCATION_MIN_INTERVAL_MS,
    1_000,
  ),
  driverLocationMaxAccuracyMeters: integer(
    env.DRIVER_LOCATION_MAX_ACCURACY_METERS,
    150,
  ),
  // Fixes recorded longer ago than this (buffered offline) are not relayed.
  driverLocationMaxFixAgeSeconds: integer(
    env.DRIVER_LOCATION_MAX_FIX_AGE_SECONDS,
    30,
  ),
  // `ride.driver_arriving` fires once the accepted driver is this close.
  driverArrivingRadiusMeters: integer(
    env.DRIVER_ARRIVING_RADIUS_METERS,
    500,
  ),
  // Coarse trip-trail checkpoints — never every GPS ping.
  rideCheckpointIntervalSeconds: integer(
    env.RIDE_CHECKPOINT_INTERVAL_SECONDS,
    60,
  ),

  // ── Payments (Phase 4, Razorpay Standard Checkout) ────────────────────
  // Test-mode keys (rzp_test_…) everywhere except production.
  razorpayKeyId: env.RAZORPAY_KEY_ID || "",
  razorpayKeySecret: env.RAZORPAY_KEY_SECRET || "",
  razorpayWebhookSecret: env.RAZORPAY_WEBHOOK_SECRET || "",
  razorpayApiBaseUrl: (
    env.RAZORPAY_API_BASE_URL || "https://api.razorpay.com/v1"
  ).replace(/\/+$/, ""),
  razorpayTimeoutMs: integer(env.RAZORPAY_TIMEOUT_MS, 10_000),
  // Shown on the Razorpay checkout sheet.
  paymentBrandName: env.PAYMENT_BRAND_NAME || "Tirvona Rides",
  // A Razorpay order is re-used for retries this long before a fresh one is
  // created, so repeated taps never pile up orders.
  paymentOrderReuseMinutes: integer(env.PAYMENT_ORDER_REUSE_MINUTES, 60),
  // Background sync with Razorpay for payments stuck in PROCESSING and for
  // captured payments whose earning is missing. 0 disables it.
  paymentReconcileIntervalMs: integer(
    env.PAYMENT_RECONCILE_INTERVAL_MS,
    60_000,
  ),
  // A PROCESSING payment older than this is re-checked with Razorpay.
  paymentProcessingStaleSeconds: integer(
    env.PAYMENT_PROCESSING_STALE_SECONDS,
    60,
  ),

  // ── Earnings (Phase 4) ────────────────────────────────────────────────
  // Seeds the first commission version only; admins own it afterwards.
  defaultCommissionPercent: decimal(env.DEFAULT_COMMISSION_PERCENT, 20),
  // Settlement window: a new earning stays PENDING this long before it is
  // AVAILABLE for payout. 0 = available as soon as the payment succeeds.
  earningsHoldHours: decimal(env.EARNINGS_HOLD_HOURS, 0),

  // ── Notifications, ratings, safety (Phase 5) ──────────────────────────
  // Where this API is reachable from the internet (share-ride links).
  publicBaseUrl: stripTrailingSlashes(env.PUBLIC_BASE_URL || "http://localhost:5100"),
  ...(() => {
    let account: FirebaseServiceAccount = { projectId: "", clientEmail: "", privateKey: "" };
    try {
      account = firebaseServiceAccountFrom(env);
    } catch {
      // Malformed JSON: validateEnvironment reports it with a clear message.
    }
    return {
      firebaseProjectId: account.projectId,
      firebaseClientEmail: account.clientEmail,
      firebasePrivateKey: account.privateKey,
    };
  })(),
  fcmTimeoutMs: integer(env.FCM_TIMEOUT_MS, 10_000),
  // Must match the channel the app creates (heads-up ride alerts).
  pushAndroidChannelId: env.PUSH_ANDROID_CHANNEL_ID || "tirvona_rides",
  // Oldest active tokens beyond this are retired (phones, tablets, reinstalls).
  deviceTokensMaxPerUser: integer(env.DEVICE_TOKENS_MAX_PER_USER, 10),
  // A paid ride can be rated this long after completion.
  ratingWindowDays: integer(env.RATING_WINDOW_DAYS, 30),
  emergencyContactsMax: integer(env.EMERGENCY_CONTACTS_MAX, 5),
  // SOS stays available this long after a ride ends (incidents at drop-off).
  sosPostRideGraceMinutes: integer(env.SOS_POST_RIDE_GRACE_MINUTES, 30),
  // Share links are `<base>/<token>`; by default the API's own status page.
  shareRideLinkBaseUrl: stripTrailingSlashes(
    env.SHARE_RIDE_LINK_BASE_URL ||
      `${stripTrailingSlashes(env.PUBLIC_BASE_URL || "http://localhost:5100")}/api/v1/shared-rides/view`,
  ),
  // Hard cap on a link's life, and how long it outlives the ride.
  shareRideMaxHours: integer(env.SHARE_RIDE_MAX_HOURS, 12),
  shareRideGraceMinutes: integer(env.SHARE_RIDE_GRACE_MINUTES, 30),
});

export const environment = (): Environment => environmentFrom(process.env);

const POSITIVE_INTEGERS = [
  "PORT",
  "THROTTLE_TTL_MS",
  "THROTTLE_LIMIT",
  "MONGODB_MIN_POOL_SIZE",
  "MONGODB_MAX_POOL_SIZE",
  "MONGODB_SERVER_SELECTION_TIMEOUT_MS",
  "MONGODB_SOCKET_TIMEOUT_MS",
  "RIDE_MIN_DISTANCE_METERS",
  "RIDE_MAX_DISTANCE_KM",
  "RIDE_SEARCH_TIMEOUT_SECONDS",
  "RIDE_ASSIGNMENT_TIMEOUT_SECONDS",
  "RIDE_OTP_TTL_MINUTES",
  "RIDE_OTP_MAX_ATTEMPTS",
  "MATCHING_DRIVER_HEARTBEAT_SECONDS",
  "REALTIME_PING_INTERVAL_MS",
  "REALTIME_PING_TIMEOUT_MS",
  "REALTIME_RECOVERY_WINDOW_MS",
  "DRIVER_LOCATION_STALE_SECONDS",
  "DRIVER_LOCATION_PERSIST_INTERVAL_SECONDS",
  "DRIVER_LOCATION_PERSIST_DISTANCE_METERS",
  "DRIVER_LOCATION_MIN_INTERVAL_MS",
  "DRIVER_LOCATION_MAX_ACCURACY_METERS",
  "DRIVER_LOCATION_MAX_FIX_AGE_SECONDS",
  "DRIVER_ARRIVING_RADIUS_METERS",
  "RIDE_CHECKPOINT_INTERVAL_SECONDS",
  "RAZORPAY_TIMEOUT_MS",
  "PAYMENT_ORDER_REUSE_MINUTES",
  "PAYMENT_PROCESSING_STALE_SECONDS",
  "FCM_TIMEOUT_MS",
  "DEVICE_TOKENS_MAX_PER_USER",
  "RATING_WINDOW_DAYS",
  "EMERGENCY_CONTACTS_MAX",
  "SOS_POST_RIDE_GRACE_MINUTES",
  "SHARE_RIDE_MAX_HOURS",
  "SHARE_RIDE_GRACE_MINUTES",
];

const POSITIVE_DECIMALS = [
  "ROUTE_AVERAGE_SPEED_KMPH",
  "ROUTE_DISTANCE_FACTOR",
  "MATCHING_RADIUS_KM",
];

const isSet = (value: unknown): boolean => String(value ?? "").trim() !== "";

export function validateEnvironment(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const nodeEnv = String(input.NODE_ENV || "development");
  if (!(NODE_ENVIRONMENTS as readonly string[]).includes(nodeEnv))
    throw new Error("NODE_ENV must be development, test, or production");

  for (const name of POSITIVE_INTEGERS) {
    if (
      isSet(input[name]) &&
      (!Number.isInteger(Number(input[name])) || Number(input[name]) < 1)
    )
      throw new Error(`${name} must be a positive integer`);
  }

  for (const name of POSITIVE_DECIMALS) {
    if (
      isSet(input[name]) &&
      (!Number.isFinite(Number(input[name])) || Number(input[name]) <= 0)
    )
      throw new Error(`${name} must be a positive number`);
  }

  if (
    isSet(input.MATCHING_SWEEP_INTERVAL_MS) &&
    (!Number.isInteger(Number(input.MATCHING_SWEEP_INTERVAL_MS)) ||
      Number(input.MATCHING_SWEEP_INTERVAL_MS) < 0)
  )
    throw new Error(
      "MATCHING_SWEEP_INTERVAL_MS must be 0 (disabled) or a positive integer",
    );

  // A driver must be able to refresh their stored location before it goes
  // stale, or a stationary online driver would silently drop out of matching.
  const resolved = environmentFrom(input as RawEnvironment);
  if (
    resolved.driverLocationPersistIntervalSeconds * 2 >
    resolved.driverLocationStaleSeconds
  )
    throw new Error(
      "DRIVER_LOCATION_STALE_SECONDS must be at least twice DRIVER_LOCATION_PERSIST_INTERVAL_SECONDS",
    );

  for (const name of ["PAYMENT_RECONCILE_INTERVAL_MS"]) {
    if (
      isSet(input[name]) &&
      (!Number.isInteger(Number(input[name])) || Number(input[name]) < 0)
    )
      throw new Error(`${name} must be 0 (disabled) or a positive integer`);
  }

  if (isSet(input.DEFAULT_COMMISSION_PERCENT)) {
    const percent = Number(input.DEFAULT_COMMISSION_PERCENT);
    if (!Number.isFinite(percent) || percent < 0 || percent > 100)
      throw new Error("DEFAULT_COMMISSION_PERCENT must be between 0 and 100");
  }
  if (isSet(input.EARNINGS_HOLD_HOURS)) {
    const hours = Number(input.EARNINGS_HOLD_HOURS);
    if (!Number.isFinite(hours) || hours < 0 || hours > 24 * 30)
      throw new Error("EARNINGS_HOLD_HOURS must be between 0 and 720");
  }

  // Razorpay keys are all-or-nothing, and live keys never leave production:
  // a developer machine or CI run must not be able to take real money.
  const keyId = String(input.RAZORPAY_KEY_ID ?? "").trim();
  const keySecret = String(input.RAZORPAY_KEY_SECRET ?? "").trim();
  if (Boolean(keyId) !== Boolean(keySecret))
    throw new Error(
      "RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET must be set together",
    );
  if (keyId && !/^rzp_(test|live)_[A-Za-z0-9]+$/.test(keyId))
    throw new Error("RAZORPAY_KEY_ID must look like rzp_test_… or rzp_live_…");
  if (keyId.startsWith("rzp_live_") && nodeEnv !== "production")
    throw new Error(
      "Live Razorpay keys (rzp_live_…) are only allowed when NODE_ENV=production",
    );
  if (isSet(input.RAZORPAY_API_BASE_URL)) {
    let protocol = "";
    try {
      protocol = new URL(String(input.RAZORPAY_API_BASE_URL)).protocol;
    } catch {
      protocol = "";
    }
    if (protocol !== "https:" && nodeEnv === "production")
      throw new Error("RAZORPAY_API_BASE_URL must be an HTTPS URL");
    if (!["http:", "https:"].includes(protocol))
      throw new Error("RAZORPAY_API_BASE_URL must be a valid URL");
  }

  // FCM credentials are all-or-nothing: a half-configured service account
  // would silently drop every push.
  let firebase: FirebaseServiceAccount;
  try {
    firebase = firebaseServiceAccountFrom(input as RawEnvironment);
  } catch {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_BASE64 must be a base64-encoded service-account JSON");
  }
  const firebaseParts = [firebase.projectId, firebase.clientEmail, firebase.privateKey].filter(Boolean).length;
  if (firebaseParts !== 0 && firebaseParts !== 3)
    throw new Error("FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY must be set together");
  if (firebase.privateKey && !firebase.privateKey.includes("PRIVATE KEY"))
    throw new Error("FIREBASE_PRIVATE_KEY must be a PEM private key");

  for (const name of ["PUBLIC_BASE_URL", "SHARE_RIDE_LINK_BASE_URL"]) {
    if (!isSet(input[name])) continue;
    let protocol = "";
    try {
      protocol = new URL(String(input[name])).protocol;
    } catch {
      protocol = "";
    }
    if (!["http:", "https:"].includes(protocol)) throw new Error(`${name} must be a valid HTTP(S) URL`);
    if (nodeEnv === "production" && protocol !== "https:")
      throw new Error(`${name} must be an HTTPS URL in production`);
  }

  if (isSet(input.APP_TIME_ZONE)) {
    try {
      new Intl.DateTimeFormat("en-US", {
        timeZone: String(input.APP_TIME_ZONE),
      });
    } catch {
      throw new Error("APP_TIME_ZONE must be a valid IANA time zone");
    }
  }

  if (isSet(input.CORS_ORIGINS)) {
    for (const origin of String(input.CORS_ORIGINS).split(",")) {
      let protocol = "";
      try {
        protocol = new URL(origin.trim()).protocol;
      } catch {
        protocol = "";
      }
      if (!["http:", "https:"].includes(protocol))
        throw new Error("CORS_ORIGINS must contain valid HTTP(S) URLs");
    }
  }

  for (const [name, protocols] of [
    ["MONGODB_URI", ["mongodb:", "mongodb+srv:"]],
    ["REDIS_URL", ["redis:", "rediss:"]],
  ] as const) {
    if (!isSet(input[name])) continue;
    let protocol = "";
    try {
      protocol = new URL(String(input[name])).protocol;
    } catch {
      protocol = "";
    }
    if (!(protocols as readonly string[]).includes(protocol))
      throw new Error(`${name} must be a valid ${protocols.join(" or ")} URL`);
  }

  if (nodeEnv === "production") {
    // Redis is deliberately not required: Phase 3 runs realtime on MongoDB +
    // a single Socket.IO node. It becomes required with the Redis adapter.
    for (const name of [
      "MONGODB_URI",
      "CORS_ORIGINS",
      "JWT_ACCESS_SECRET",
      "JWT_REFRESH_SECRET",
      "RAZORPAY_KEY_ID",
      "RAZORPAY_KEY_SECRET",
      "RAZORPAY_WEBHOOK_SECRET",
      "PUBLIC_BASE_URL",
    ]) {
      if (!isSet(input[name]))
        throw new Error(`${name} is required in production`);
    }
    if (String(input.RAZORPAY_WEBHOOK_SECRET).length < 12)
      throw new Error("RAZORPAY_WEBHOOK_SECRET must contain at least 12 characters");
    for (const name of ["JWT_ACCESS_SECRET", "JWT_REFRESH_SECRET"]) {
      if (String(input[name]).length < 32)
        throw new Error(`${name} must contain at least 32 characters`);
    }
    if (input.JWT_ACCESS_SECRET === input.JWT_REFRESH_SECRET)
      throw new Error("JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must differ");
    if (String(input.CORS_ORIGINS).includes("*"))
      throw new Error("Wildcard CORS origins are not allowed in production");
  }

  return input;
}
