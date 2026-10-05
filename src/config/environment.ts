const NODE_ENVIRONMENTS = ["development", "test", "production"] as const;
export type NodeEnvironment = (typeof NODE_ENVIRONMENTS)[number];

const FINAL_FARE_MODES = ["actual", "booked"] as const;
export type FinalFareMode = (typeof FINAL_FARE_MODES)[number];

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
  routesProvider: RoutesProviderName;
  googleRoutesApiKey: string;
  routesTravelMode: "DRIVE" | "TWO_WHEELER";
  routesTrafficAware: boolean;
  routesTimeoutMs: number;
  routesCacheTtlSeconds: number;
  routesCacheMaxEntries: number;
  routesFailureThreshold: number;
  routesFailureCooldownSeconds: number;
  routesLiveRefreshSeconds: number;
  routesLiveRefreshMeters: number;
  rideSearchTimeoutSeconds: number;
  rideAssignmentTimeoutSeconds: number;
  rideOtpTtlMinutes: number;
  rideOtpMaxAttempts: number;
  nearbyDriversLimit: number;
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
  /** Circuits: how close (m) the driver must be to mark a stop arrived; 0 = do not check. */
  circuitStopArrivalRadiusMeters: number;
  /** Circuits: usage/warning monitor period; 0 disables the background monitor. */
  circuitMonitorIntervalMs: number;
  /** Circuits: the pickup may be at most this far (straight line) from the first stop. */
  circuitMaxPickupDistanceKm: number;
  finalFareMode: FinalFareMode;
  finalFareMaxEstimateMultiplier: number;
  tripMeterMaxGapSeconds: number;
  razorpayKeyId: string;
  razorpayKeySecret: string;
  razorpayWebhookSecret: string;
  razorpayApiBaseUrl: string;
  razorpayTimeoutMs: number;
  paymentBrandName: string;
  paymentOrderReuseMinutes: number;
  paymentReconcileIntervalMs: number;
  paymentProcessingStaleSeconds: number;
  paymentRefundWindowDays: number;
  paymentDailyReconciliation: boolean;
  paymentDailyReconciliationHour: number;
  paymentReconciliationMaxDays: number;
  defaultCommissionPercent: number;
  earningsHoldHours: number;
  publicBaseUrl: string;
  firebaseProjectId: string;
  firebaseClientEmail: string;
  firebasePrivateKey: string;
  fcmTimeoutMs: number;
  deviceTokensMaxPerUser: number;
  ratingWindowDays: number;
  emergencyContactsMax: number;
  sosPostRideGraceMinutes: number;
  shareRideLinkBaseUrl: string;
  shareRideMaxHours: number;
  shareRideGraceMinutes: number;
  // SOS alerts to emergency contacts over WhatsApp (docs/safety/sos-whatsapp.md)
  sosContactAlertsEnabled: boolean;
  sosContactUpdateMinSeconds: number;
  sosContactUpdateMax: number;
  sosContactRetryDelayMs: number;
  whatsappSosTemplateName: string;
  whatsappSosUpdateTemplateName: string;
  whatsappSosTemplateLanguage: string;
  placesProvider: PlacesProviderName;
  placesFallback: PlacesFallbackName;
  placesFailureThreshold: number;
  placesFailureCooldownSeconds: number;
  googleMapsApiKey: string;
  nominatimBaseUrl: string;
  nominatimContactEmail: string;
  nominatimMinIntervalMs: number;
  photonBaseUrl: string;
  photonMinIntervalMs: number;
  placesCountryCodes: string[];
  placesBiasLatitude: number;
  placesBiasLongitude: number;
  placesBiasRadiusKm: number;
  placesFeaturedRadiusKm: number;
  placesTimeoutMs: number;
  placesCacheTtlSeconds: number;
  placesCacheMaxEntries: number;
  // Phase 7
  throttleAuthLimit: number;
  throttleAuthTtlMs: number;
  throttleSignupLimit: number;
  throttleSignupTtlMs: number;
  throttleOtpSendLimit: number;
  throttleOtpSendTtlMs: number;
  throttleOtpVerifyLimit: number;
  throttleOtpVerifyTtlMs: number;
  throttleRefreshLimit: number;
  throttleRefreshTtlMs: number;
  throttleAdminLoginLimit: number;
  throttleAdminLoginTtlMs: number;
  throttlePromoLimit: number;
  throttlePromoTtlMs: number;
  broadcastWorkerIntervalMs: number;
  broadcastBatchSize: number;
  reportMaxRangeDays: number;
  // Signup OTP over WhatsApp (docs/auth/whatsapp-otp.md)
  whatsappProvider: WhatsAppProviderName;
  whatsappApiBaseUrl: string;
  whatsappApiVersion: string;
  whatsappPhoneNumberId: string;
  whatsappBusinessAccountId: string;
  whatsappAccessToken: string;
  whatsappOtpTemplateName: string;
  whatsappOtpTemplateLanguage: string;
  whatsappOtpTemplateCodeButton: boolean;
  whatsappTimeoutMs: number;
  otpTtlSeconds: number;
  otpMaxAttempts: number;
  otpResendCooldownSeconds: number;
  otpMaxSendsPerWindow: number;
  otpSendWindowMinutes: number;
  otpHashSecret: string;
  signupPendingTtlMinutes: number;
  passwordResetTokenTtlMinutes: number;
}

export const WHATSAPP_PROVIDERS = ["meta", "log"] as const;
export type WhatsAppProviderName = (typeof WHATSAPP_PROVIDERS)[number];

export const PLACES_PROVIDERS = ["osm", "photon", "nominatim", "google", "none"] as const;
export type PlacesProviderName = (typeof PLACES_PROVIDERS)[number];
export const PLACES_FALLBACKS = ["osm", "none"] as const;
export type PlacesFallbackName = (typeof PLACES_FALLBACKS)[number];

export const ROUTES_PROVIDERS = ["google", "haversine"] as const;
export type RoutesProviderName = (typeof ROUTES_PROVIDERS)[number];
const ROUTES_TRAVEL_MODES = ["DRIVE", "TWO_WHEELER"] as const;

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
  // Straight-line (Haversine) estimate: the fallback whenever Google Routes
  // is off or failing, and the only estimate with ROUTES_PROVIDER=haversine.
  routeAverageSpeedKmph: decimal(env.ROUTE_AVERAGE_SPEED_KMPH, 22),
  routeDistanceFactor: decimal(env.ROUTE_DISTANCE_FACTOR, 1),

  // ── Road routing (Google Routes API, server-side key) ─────────────────
  // "google" whenever GOOGLE_ROUTES_API_KEY is set, unless overridden.
  routesProvider: ((env.ROUTES_PROVIDER || "").trim().toLowerCase() ||
    (env.GOOGLE_ROUTES_API_KEY?.trim() ? "google" : "haversine")) as RoutesProviderName,
  googleRoutesApiKey: (env.GOOGLE_ROUTES_API_KEY || "").trim(),
  // TWO_WHEELER routes suit bikes/autos in India; DRIVE is the safe default.
  routesTravelMode: ((env.ROUTES_TRAVEL_MODE || "DRIVE").trim().toUpperCase() as "DRIVE" | "TWO_WHEELER"),
  // Live-traffic durations cost the Routes "Advanced" SKU; off by default.
  routesTrafficAware: boolean(env.ROUTES_TRAFFIC_AWARE, false),
  routesTimeoutMs: integer(env.ROUTES_TIMEOUT_MS, 4_000),
  // Same trip within this window = one Google call (estimate → book).
  routesCacheTtlSeconds: integer(env.ROUTES_CACHE_TTL_SECONDS, 900),
  routesCacheMaxEntries: integer(env.ROUTES_CACHE_MAX_ENTRIES, 5_000),
  // Circuit breaker: skip Google after this many straight failures…
  routesFailureThreshold: integer(env.ROUTES_FAILURE_THRESHOLD, 3),
  // …for this long, answering with straight-line estimates meanwhile.
  routesFailureCooldownSeconds: integer(env.ROUTES_FAILURE_COOLDOWN_SECONDS, 60),
  // Live driver → pickup/destination route: recomputed at most this often,
  // or sooner once the driver has moved this far from where it was computed.
  routesLiveRefreshSeconds: integer(env.ROUTES_LIVE_REFRESH_SECONDS, 90),
  routesLiveRefreshMeters: integer(env.ROUTES_LIVE_REFRESH_METERS, 300),
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
  // Trip distance limits and the matching / nearby-drivers radii are admin
  // settings stored in MongoDB (modules/ride-config), not environment.
  // Cars drawn on the rider Home map (approximate positions, no identities):
  nearbyDriversLimit: integer(env.NEARBY_DRIVERS_LIMIT, 12),
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
  // Trip-trail checkpoints — never every GPS ping. The trail is also the
  // trip meter for the final fare, so it must be dense enough to follow roads.
  rideCheckpointIntervalSeconds: integer(
    env.RIDE_CHECKPOINT_INTERVAL_SECONDS,
    15,
  ),

  // ── Circuits ──────────────────────────────────────────────────────────
  circuitStopArrivalRadiusMeters: integer(env.CIRCUIT_STOP_ARRIVAL_RADIUS_METERS, 1000),
  circuitMonitorIntervalMs: integer(env.CIRCUIT_MONITOR_INTERVAL_MS, 30_000),
  circuitMaxPickupDistanceKm: integer(env.CIRCUIT_MAX_PICKUP_DISTANCE_KM, 60),

  // ── Final fare (Razorpay integration v2) ──────────────────────────────
  // actual = actual trip time + GPS-trail distance (booked distance when the
  // trail is unreliable); booked = the booked route's distance and time.
  finalFareMode: (env.FINAL_FARE_MODE || "actual").toLowerCase() as FinalFareMode,
  // Customer protection: the final fare never exceeds estimate × this. 0 = no cap.
  finalFareMaxEstimateMultiplier: decimal(env.FINAL_FARE_MAX_ESTIMATE_MULTIPLIER, 1.5),
  // A trail with a longer gap between two fixes is not trusted for distance.
  tripMeterMaxGapSeconds: integer(env.TRIP_METER_MAX_GAP_SECONDS, 120),

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
  // Razorpay accepts refunds for 6 months after capture.
  paymentRefundWindowDays: integer(env.PAYMENT_REFUND_WINDOW_DAYS, 180),
  // Automatic Razorpay-vs-MongoDB reconciliation of the previous business day.
  paymentDailyReconciliation: boolean(env.PAYMENT_DAILY_RECONCILIATION, true),
  // Local hour after which yesterday's run starts (Razorpay settles overnight).
  paymentDailyReconciliationHour: integer(env.PAYMENT_DAILY_RECONCILIATION_HOUR, 3),
  // Longest range an admin reconciliation run may cover.
  paymentReconciliationMaxDays: integer(env.PAYMENT_RECONCILIATION_MAX_DAYS, 31),

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
  // An SOS messages the user's emergency contacts on WhatsApp (an approved
  // template is required: docs/safety/sos-whatsapp.md). Off switch for
  // environments without the templates.
  sosContactAlertsEnabled: boolean(env.SOS_CONTACT_WHATSAPP_ENABLED, true),
  // While an SOS stays open, a newer position is re-sent to the contacts at
  // most this often, and at most this many times (each one is a paid message).
  sosContactUpdateMinSeconds: integer(env.SOS_CONTACT_UPDATE_MIN_SECONDS, 120),
  sosContactUpdateMax: integer(env.SOS_CONTACT_UPDATE_MAX, 8),
  // Pause before retrying a WhatsApp send that failed for a transient reason (×attempt).
  sosContactRetryDelayMs: integer(env.SOS_CONTACT_RETRY_DELAY_MS, 1500),
  whatsappSosTemplateName: (env.WHATSAPP_SOS_TEMPLATE_NAME || "tirvona_sos_alert").trim(),
  // Empty = no location updates after the first alert (only the first template exists).
  whatsappSosUpdateTemplateName: (env.WHATSAPP_SOS_UPDATE_TEMPLATE_NAME || "").trim(),
  whatsappSosTemplateLanguage: (env.WHATSAPP_SOS_TEMPLATE_LANGUAGE || "en").trim(),

  // ── Place search (autocomplete, reverse geocoding) ────────────────────
  // Proxied through the API so map keys never ship inside the app and every
  // lookup is cached and rate-limited in one place. "osm" (the free
  // default) is Photon with Nominatim as fallback; "google" needs
  // GOOGLE_MAPS_API_KEY; "none" leaves only the curated popular places.
  placesProvider: ((env.PLACES_PROVIDER || "").trim().toLowerCase() ||
    (env.GOOGLE_MAPS_API_KEY ? "google" : "osm")) as PlacesProviderName,
  // PLACES_PROVIDER=google only: when Google fails (outage, quota, key
  // rejected) search and reverse geocoding use the free OSM pair instead of
  // dropping to the curated list. "none" keeps rider queries on Google only.
  placesFallback: ((env.PLACES_FALLBACK || "osm").trim().toLowerCase() as PlacesFallbackName),
  // After this many straight Google failures (or one key/permission error)…
  placesFailureThreshold: integer(env.PLACES_FAILURE_THRESHOLD, 3),
  // …Google is skipped for this long, so an outage adds no latency.
  placesFailureCooldownSeconds: integer(env.PLACES_FAILURE_COOLDOWN_SECONDS, 60),
  googleMapsApiKey: (env.GOOGLE_MAPS_API_KEY || "").trim(),
  nominatimBaseUrl: stripTrailingSlashes(env.NOMINATIM_BASE_URL || "https://nominatim.openstreetmap.org"),
  nominatimContactEmail: (env.NOMINATIM_CONTACT_EMAIL || "").trim(),
  // The public Nominatim allows 1 request/second per application; a
  // self-hosted instance can lower this (0 = no spacing).
  nominatimMinIntervalMs: integer(env.NOMINATIM_MIN_INTERVAL_MS, 1_000),
  photonBaseUrl: stripTrailingSlashes(env.PHOTON_BASE_URL || "https://photon.komoot.io"),
  // Fair use of the public Photon; 0 for a self-hosted instance.
  photonMinIntervalMs: integer(env.PHOTON_MIN_INTERVAL_MS, 200),
  placesCountryCodes: csv(env.PLACES_COUNTRY_CODES, "in").map((code) => code.toLowerCase()),
  // Results near the service area rank first (Vrindavan–Mathura by default).
  placesBiasLatitude: decimal(env.PLACES_BIAS_LATITUDE, 27.5406),
  placesBiasLongitude: decimal(env.PLACES_BIAS_LONGITUDE, 77.6708),
  placesBiasRadiusKm: decimal(env.PLACES_BIAS_RADIUS_KM, 50),
  // Riders farther than this from every curated Braj landmark (testers in
  // Noida, pilgrims still at home) get no "Popular in Braj" list, and local
  // search results rank ahead of curated matches.
  placesFeaturedRadiusKm: decimal(env.PLACES_FEATURED_RADIUS_KM, 75),
  placesTimeoutMs: integer(env.PLACES_TIMEOUT_MS, 5_000),
  placesCacheTtlSeconds: integer(env.PLACES_CACHE_TTL_SECONDS, 21_600),
  placesCacheMaxEntries: integer(env.PLACES_CACHE_MAX_ENTRIES, 5_000),

  // ── Phase 7: abuse-prone endpoint limits (per client IP, per route) ───
  // Stricter than THROTTLE_LIMIT, which covers ordinary authenticated calls.
  throttleAuthLimit: integer(env.THROTTLE_AUTH_LIMIT, 10),
  throttleAuthTtlMs: integer(env.THROTTLE_AUTH_TTL_MS, 60_000),
  // Every signup sends a paid WhatsApp message: per-IP budget on top of the
  // per-number OTP quota.
  throttleSignupLimit: integer(env.THROTTLE_SIGNUP_LIMIT, 10),
  throttleSignupTtlMs: integer(env.THROTTLE_SIGNUP_TTL_MS, 600_000),
  // WhatsApp messages cost money and can be used to harass a number.
  throttleOtpSendLimit: integer(env.THROTTLE_OTP_SEND_LIMIT, 3),
  throttleOtpSendTtlMs: integer(env.THROTTLE_OTP_SEND_TTL_MS, 600_000),
  throttleOtpVerifyLimit: integer(env.THROTTLE_OTP_VERIFY_LIMIT, 10),
  throttleOtpVerifyTtlMs: integer(env.THROTTLE_OTP_VERIFY_TTL_MS, 600_000),
  throttleRefreshLimit: integer(env.THROTTLE_REFRESH_LIMIT, 30),
  throttleRefreshTtlMs: integer(env.THROTTLE_REFRESH_TTL_MS, 60_000),
  throttleAdminLoginLimit: integer(env.THROTTLE_ADMIN_LOGIN_LIMIT, 5),
  throttleAdminLoginTtlMs: integer(env.THROTTLE_ADMIN_LOGIN_TTL_MS, 300_000),
  // Promo codes are guessable strings: limit how fast one client can try them.
  throttlePromoLimit: integer(env.THROTTLE_PROMO_LIMIT, 20),
  throttlePromoTtlMs: integer(env.THROTTLE_PROMO_TTL_MS, 60_000),
  // Admin broadcasts: scheduled-send poll (0 = off) and users per batch.
  broadcastWorkerIntervalMs: integer(env.BROADCAST_WORKER_INTERVAL_MS, 30_000),
  broadcastBatchSize: integer(env.BROADCAST_BATCH_SIZE, 500),
  reportMaxRangeDays: integer(env.REPORT_MAX_RANGE_DAYS, 366),

  // ── Signup OTP over WhatsApp (Meta Cloud API) ─────────────────────────
  // "meta" whenever an access token is set; "log" prints codes to the
  // server log and is refused in production.
  whatsappProvider: ((env.WHATSAPP_PROVIDER || "").trim().toLowerCase() ||
    (env.WHATSAPP_ACCESS_TOKEN?.trim() ? "meta" : "log")) as WhatsAppProviderName,
  whatsappApiBaseUrl: stripTrailingSlashes((env.WHATSAPP_API_BASE_URL || "https://graph.facebook.com").trim()),
  whatsappApiVersion: (env.WHATSAPP_API_VERSION || "v23.0").trim(),
  whatsappPhoneNumberId: (env.WHATSAPP_PHONE_NUMBER_ID || "").trim(),
  whatsappBusinessAccountId: (env.WHATSAPP_BUSINESS_ACCOUNT_ID || "").trim(),
  whatsappAccessToken: (env.WHATSAPP_ACCESS_TOKEN || "").trim(),
  whatsappOtpTemplateName: (env.WHATSAPP_OTP_TEMPLATE_NAME || "tirvona_signup_otp").trim(),
  whatsappOtpTemplateLanguage: (env.WHATSAPP_OTP_TEMPLATE_LANGUAGE || "en").trim(),
  // Authentication templates with a copy-code / one-tap button need the
  // code repeated as the button parameter.
  whatsappOtpTemplateCodeButton: boolean(env.WHATSAPP_OTP_TEMPLATE_CODE_BUTTON, true),
  whatsappTimeoutMs: integer(env.WHATSAPP_TIMEOUT_MS, 10_000),
  // Must match the template's "code expires in N minutes" setting in Meta.
  otpTtlSeconds: integer(env.OTP_TTL_SECONDS, 300),
  otpMaxAttempts: integer(env.OTP_MAX_ATTEMPTS, 5),
  otpResendCooldownSeconds: integer(env.OTP_RESEND_COOLDOWN_SECONDS, 60),
  // Per phone number: at most this many codes per rolling window.
  otpMaxSendsPerWindow: integer(env.OTP_MAX_SENDS_PER_WINDOW, 5),
  otpSendWindowMinutes: integer(env.OTP_SEND_WINDOW_MINUTES, 60),
  // HMAC key for stored OTP hashes (a bare hash of a 6-digit code is
  // reversible from a DB dump in milliseconds). Required in production.
  otpHashSecret: (env.OTP_HASH_SECRET || env.JWT_ACCESS_SECRET || "tirvona-dev-otp-hash-secret").trim(),
  // How long a submitted sign-up form waits for its OTP (resends included).
  signupPendingTtlMinutes: integer(env.SIGNUP_PENDING_TTL_MINUTES, 30),
  // How long the one-time token from a verified reset code may set a new password.
  passwordResetTokenTtlMinutes: integer(env.PASSWORD_RESET_TOKEN_TTL_MINUTES, 10),
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
  "ROUTES_TIMEOUT_MS",
  "ROUTES_CACHE_TTL_SECONDS",
  "ROUTES_CACHE_MAX_ENTRIES",
  "ROUTES_FAILURE_THRESHOLD",
  "ROUTES_FAILURE_COOLDOWN_SECONDS",
  "ROUTES_LIVE_REFRESH_SECONDS",
  "ROUTES_LIVE_REFRESH_METERS",
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
  "SOS_CONTACT_UPDATE_MIN_SECONDS",
  "SOS_CONTACT_UPDATE_MAX",
  "SOS_CONTACT_RETRY_DELAY_MS",
  "SHARE_RIDE_MAX_HOURS",
  "SHARE_RIDE_GRACE_MINUTES",
  "PLACES_TIMEOUT_MS",
  "PLACES_FAILURE_THRESHOLD",
  "PLACES_FAILURE_COOLDOWN_SECONDS",
  "PLACES_CACHE_TTL_SECONDS",
  "PLACES_CACHE_MAX_ENTRIES",
  "THROTTLE_AUTH_LIMIT",
  "THROTTLE_AUTH_TTL_MS",
  "THROTTLE_SIGNUP_LIMIT",
  "THROTTLE_SIGNUP_TTL_MS",
  "THROTTLE_OTP_SEND_LIMIT",
  "THROTTLE_OTP_SEND_TTL_MS",
  "THROTTLE_OTP_VERIFY_LIMIT",
  "THROTTLE_OTP_VERIFY_TTL_MS",
  "THROTTLE_REFRESH_LIMIT",
  "THROTTLE_REFRESH_TTL_MS",
  "THROTTLE_ADMIN_LOGIN_LIMIT",
  "THROTTLE_ADMIN_LOGIN_TTL_MS",
  "THROTTLE_PROMO_LIMIT",
  "THROTTLE_PROMO_TTL_MS",
  "BROADCAST_BATCH_SIZE",
  "REPORT_MAX_RANGE_DAYS",
  "TRIP_METER_MAX_GAP_SECONDS",
  "PAYMENT_RECONCILIATION_MAX_DAYS",
  "WHATSAPP_TIMEOUT_MS",
  "OTP_TTL_SECONDS",
  "OTP_MAX_ATTEMPTS",
  "OTP_RESEND_COOLDOWN_SECONDS",
  "OTP_MAX_SENDS_PER_WINDOW",
  "OTP_SEND_WINDOW_MINUTES",
  "SIGNUP_PENDING_TTL_MINUTES",
  "PASSWORD_RESET_TOKEN_TTL_MINUTES",
];

const POSITIVE_DECIMALS = [
  "ROUTE_AVERAGE_SPEED_KMPH",
  "ROUTE_DISTANCE_FACTOR",
  "PLACES_BIAS_RADIUS_KM",
  "PLACES_FEATURED_RADIUS_KM",
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

  for (const name of ["PAYMENT_RECONCILE_INTERVAL_MS", "BROADCAST_WORKER_INTERVAL_MS"]) {
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
  if (isSet(input.FINAL_FARE_MODE) && !(FINAL_FARE_MODES as readonly string[]).includes(String(input.FINAL_FARE_MODE).toLowerCase()))
    throw new Error("FINAL_FARE_MODE must be actual or booked");
  if (isSet(input.FINAL_FARE_MAX_ESTIMATE_MULTIPLIER)) {
    const multiplier = Number(input.FINAL_FARE_MAX_ESTIMATE_MULTIPLIER);
    if (!Number.isFinite(multiplier) || (multiplier !== 0 && (multiplier < 1 || multiplier > 10)))
      throw new Error("FINAL_FARE_MAX_ESTIMATE_MULTIPLIER must be 0 (no cap) or between 1 and 10");
  }
  if (isSet(input.PAYMENT_DAILY_RECONCILIATION_HOUR)) {
    const hour = Number(input.PAYMENT_DAILY_RECONCILIATION_HOUR);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23)
      throw new Error("PAYMENT_DAILY_RECONCILIATION_HOUR must be an hour between 0 and 23");
  }
  if (isSet(input.PAYMENT_REFUND_WINDOW_DAYS)) {
    const days = Number(input.PAYMENT_REFUND_WINDOW_DAYS);
    if (!Number.isInteger(days) || days < 1 || days > 365)
      throw new Error("PAYMENT_REFUND_WINDOW_DAYS must be between 1 and 365");
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

  // Place search: a known provider, Google only with its key, and a bias
  // point that is a real coordinate.
  if (!(PLACES_PROVIDERS as readonly string[]).includes(resolved.placesProvider))
    throw new Error(`PLACES_PROVIDER must be one of ${PLACES_PROVIDERS.join(", ")}`);
  if (resolved.placesProvider === "google" && !resolved.googleMapsApiKey)
    throw new Error("GOOGLE_MAPS_API_KEY is required when PLACES_PROVIDER=google");
  if (!(PLACES_FALLBACKS as readonly string[]).includes(resolved.placesFallback))
    throw new Error(`PLACES_FALLBACK must be one of ${PLACES_FALLBACKS.join(", ")}`);
  // Road routing: a known provider and travel mode, Google only with its key.
  if (!(ROUTES_PROVIDERS as readonly string[]).includes(resolved.routesProvider))
    throw new Error(`ROUTES_PROVIDER must be one of ${ROUTES_PROVIDERS.join(", ")}`);
  if (resolved.routesProvider === "google" && !resolved.googleRoutesApiKey)
    throw new Error("GOOGLE_ROUTES_API_KEY is required when ROUTES_PROVIDER=google");
  if (!(ROUTES_TRAVEL_MODES as readonly string[]).includes(resolved.routesTravelMode))
    throw new Error(`ROUTES_TRAVEL_MODE must be one of ${ROUTES_TRAVEL_MODES.join(", ")}`);
  if (
    isSet(input.NOMINATIM_MIN_INTERVAL_MS) &&
    (!Number.isInteger(Number(input.NOMINATIM_MIN_INTERVAL_MS)) || Number(input.NOMINATIM_MIN_INTERVAL_MS) < 0)
  )
    throw new Error("NOMINATIM_MIN_INTERVAL_MS must be 0 or a positive integer");
  if (
    isSet(input.PHOTON_MIN_INTERVAL_MS) &&
    (!Number.isInteger(Number(input.PHOTON_MIN_INTERVAL_MS)) || Number(input.PHOTON_MIN_INTERVAL_MS) < 0)
  )
    throw new Error("PHOTON_MIN_INTERVAL_MS must be 0 or a positive integer");
  if (isSet(input.PLACES_BIAS_LATITUDE) && Math.abs(Number(input.PLACES_BIAS_LATITUDE)) > 90)
    throw new Error("PLACES_BIAS_LATITUDE must be between -90 and 90");
  if (isSet(input.PLACES_BIAS_LONGITUDE) && Math.abs(Number(input.PLACES_BIAS_LONGITUDE)) > 180)
    throw new Error("PLACES_BIAS_LONGITUDE must be between -180 and 180");
  for (const code of resolved.placesCountryCodes)
    if (!/^[a-z]{2}$/.test(code)) throw new Error("PLACES_COUNTRY_CODES must be two-letter ISO country codes");
  for (const name of ["NOMINATIM_BASE_URL", "PHOTON_BASE_URL"] as const) {
    if (!isSet(input[name])) continue;
    let protocol = "";
    try {
      protocol = new URL(String(input[name])).protocol;
    } catch {
      protocol = "";
    }
    if (!["http:", "https:"].includes(protocol)) throw new Error(`${name} must be a valid HTTP(S) URL`);
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

  // Signup OTP: a known WhatsApp provider, complete Meta credentials when it
  // is used, and OTP windows that fit inside each other.
  if (!(WHATSAPP_PROVIDERS as readonly string[]).includes(resolved.whatsappProvider))
    throw new Error(`WHATSAPP_PROVIDER must be one of ${WHATSAPP_PROVIDERS.join(", ")}`);
  if (resolved.whatsappProvider === "meta") {
    for (const name of ["WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_ACCESS_TOKEN"]) {
      if (!isSet(input[name])) throw new Error(`${name} is required when WHATSAPP_PROVIDER=meta`);
    }
  }
  if (isSet(input.WHATSAPP_PHONE_NUMBER_ID) && !/^\d{5,32}$/.test(resolved.whatsappPhoneNumberId))
    throw new Error("WHATSAPP_PHONE_NUMBER_ID must be the numeric Phone Number ID from Meta (not the phone number)");
  if (isSet(input.WHATSAPP_BUSINESS_ACCOUNT_ID) && !/^\d{5,32}$/.test(resolved.whatsappBusinessAccountId))
    throw new Error("WHATSAPP_BUSINESS_ACCOUNT_ID must be numeric");
  if (!/^v\d+\.\d+$/.test(resolved.whatsappApiVersion))
    throw new Error("WHATSAPP_API_VERSION must look like v23.0");
  if (!/^[a-z0-9_]{1,512}$/.test(resolved.whatsappOtpTemplateName))
    throw new Error("WHATSAPP_OTP_TEMPLATE_NAME must contain only lowercase letters, digits and underscores");
  if (!/^[a-z]{2,3}(_[A-Z]{2})?$/.test(resolved.whatsappOtpTemplateLanguage))
    throw new Error("WHATSAPP_OTP_TEMPLATE_LANGUAGE must be a Meta language code such as en or en_US");
  for (const [name, value] of [
    ["WHATSAPP_SOS_TEMPLATE_NAME", resolved.whatsappSosTemplateName],
    ["WHATSAPP_SOS_UPDATE_TEMPLATE_NAME", resolved.whatsappSosUpdateTemplateName],
  ] as const)
    if (value && !/^[a-z0-9_]{1,512}$/.test(value))
      throw new Error(`${name} must contain only lowercase letters, digits and underscores`);
  if (!/^[a-z]{2,3}(_[A-Z]{2})?$/.test(resolved.whatsappSosTemplateLanguage))
    throw new Error("WHATSAPP_SOS_TEMPLATE_LANGUAGE must be a Meta language code such as en or en_US");
  if (isSet(input.WHATSAPP_API_BASE_URL)) {
    let protocol = "";
    try {
      protocol = new URL(resolved.whatsappApiBaseUrl).protocol;
    } catch {
      protocol = "";
    }
    if (!["http:", "https:"].includes(protocol)) throw new Error("WHATSAPP_API_BASE_URL must be a valid HTTP(S) URL");
    if (nodeEnv === "production" && protocol !== "https:")
      throw new Error("WHATSAPP_API_BASE_URL must be an HTTPS URL in production");
  }
  if (resolved.otpTtlSeconds < 60 || resolved.otpTtlSeconds > 1_800)
    throw new Error("OTP_TTL_SECONDS must be between 60 and 1800");
  if (resolved.otpMaxAttempts > 10) throw new Error("OTP_MAX_ATTEMPTS must be at most 10");
  if (resolved.otpResendCooldownSeconds >= resolved.otpTtlSeconds)
    throw new Error("OTP_RESEND_COOLDOWN_SECONDS must be shorter than OTP_TTL_SECONDS");
  if (resolved.otpSendWindowMinutes * 60 < resolved.otpResendCooldownSeconds * resolved.otpMaxSendsPerWindow)
    throw new Error("OTP_SEND_WINDOW_MINUTES is too short for OTP_MAX_SENDS_PER_WINDOW resends at the cooldown");
  if (resolved.signupPendingTtlMinutes * 60 < resolved.otpTtlSeconds)
    throw new Error("SIGNUP_PENDING_TTL_MINUTES must cover at least one OTP lifetime (OTP_TTL_SECONDS)");

  if (nodeEnv === "production") {
    // Signup cannot work without a real WhatsApp sender, and dev codes in
    // the server log must never reach production.
    if (resolved.whatsappProvider !== "meta")
      throw new Error("WHATSAPP_PROVIDER must be meta in production");
    if (String(input.OTP_HASH_SECRET ?? "").trim().length < 32)
      throw new Error("OTP_HASH_SECRET must contain at least 32 characters in production");
    // Redis is deliberately not required: Phase 3 runs realtime on MongoDB +
    // a single Socket.IO node. It becomes required with the Redis adapter.
    // PAYMENTS_ENABLED=false is an explicit opt-out for deployments without a
    // Razorpay account yet: /payments/* answer 503 PAYMENT_GATEWAY_NOT_CONFIGURED
    // and the reconciler skips gateway calls. Forgetting the keys still fails.
    const paymentsEnabled = boolean(
      isSet(input.PAYMENTS_ENABLED) ? String(input.PAYMENTS_ENABLED) : undefined,
      true,
    );
    const razorpayKeys = ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET"];
    for (const name of [
      "MONGODB_URI",
      "CORS_ORIGINS",
      "JWT_ACCESS_SECRET",
      "JWT_REFRESH_SECRET",
      ...(paymentsEnabled ? razorpayKeys : []),
      "PUBLIC_BASE_URL",
    ]) {
      if (!isSet(input[name]))
        throw new Error(`${name} is required in production`);
    }
    if (isSet(input.RAZORPAY_WEBHOOK_SECRET) && String(input.RAZORPAY_WEBHOOK_SECRET).length < 12)
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
