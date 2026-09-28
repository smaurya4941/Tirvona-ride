# Road routing (Google Routes API)

Trips are priced and drawn on real roads. The API calls the Google Routes API
(`directions/v2:computeRoutes`) with a **server-side** key; the apps never
see it. Whenever Google is off or failing, the API answers with the old
straight-line (Haversine) estimate instead, so booking never depends on it.

## Setup

1. Google Cloud → enable **Routes API** (leave Directions / Distance Matrix off).
2. Create the key "TIRVONA SERVER ROUTES KEY": API restriction = Routes API
   only; application restriction = the server's IP address(es) once it has a
   fixed one. This is **not** the Android Maps key (that one lives in the app's
   `android/secrets.properties` and only allows the Maps SDK for Android).
3. `.env`: `GOOGLE_ROUTES_API_KEY=...`. With the key set, `ROUTES_PROVIDER`
   defaults to `google`; set `ROUTES_PROVIDER=haversine` to switch Google off
   without removing the key.

On boot the API logs `Routing: Google Routes API with straight-line fallback`
(or `Routing: straight-line (Haversine) estimates`).

## What uses it

| Where | Call | Stored / returned |
| --- | --- | --- |
| `POST /rides/estimate`, `/rides/estimate/all`, `/promotions/validate` | pickup → destination | `distanceMeters`, `durationSeconds`, `routeProvider`, `routePolyline` |
| `POST /rides` (booking) | same trip (normally a cache hit) | saved on the ride: `routeProvider`, `routePolyline`; fare priced on road distance/time |
| `GET /rides/:id/route` (new) | driver → pickup (`APPROACH`, while `DRIVER_ACCEPTED`) or driver → destination (`TRIP`, while `RIDE_STARTED`) | `{ stage, origin, destination, distanceMeters, durationSeconds, provider, polyline?, computedAt }`, or `null` in any other status / before the driver's position is known |

`routeProvider` is `GOOGLE_ROUTES` or `HAVERSINE`; `routePolyline`/`polyline`
are Google encoded polylines (precision 5, overview quality) and are absent for
straight-line answers. The Flutter app decodes them in
`lib/core/maps/polyline.dart` and draws them in `RideMap`; the customer's
status card shows the road ETA ("about 6 min · 2.1 km away").

`GET /rides/:id/route` is only for the ride's own customer and driver
(anyone else gets 404 `RIDE_NOT_FOUND`). Both apps poll it every 20 s.

## Cost control

- **Field mask** `routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline`
  and `TRAFFIC_UNAWARE` keep every call on the Routes **Basic** SKU.
  `ROUTES_TRAFFIC_AWARE=true` buys live-traffic durations at the Advanced price.
- **Trip cache** (`ROUTES_CACHE_TTL_SECONDS`, 15 min): one Google call covers
  estimate → estimate/all → promo check → booking for the same trip; points
  within ~11 m share an entry; concurrent identical requests share one call.
- **Live route** (`LiveRouteService`): app polls are answered from cache; Google
  is called again only when the stage changes, the driver has moved more than
  `ROUTES_LIVE_REFRESH_METERS` (300 m) from where the route was computed, or it
  is older than `ROUTES_LIVE_REFRESH_SECONDS` (90 s). Roughly ≤ 1 call per
  minute per active ride.
- Invalid trips (too short / too long) are rejected on the straight line
  before any Google call.

## Failure handling (`ResilientRouteEstimator`)

- Any failure → straight-line answer for that request (not cached).
- `ROUTES_FAILURE_THRESHOLD` (3) consecutive timeouts / 429 / 5xx, or a single
  configuration error (403 key not authorised, API disabled, 400) → Google is
  skipped for `ROUTES_FAILURE_COOLDOWN_SECONDS` (60 s); the log says so at
  ERROR level. After the cooldown the next request tries Google again.
- "No route found" (empty answer) falls back but does not count as a failure.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `ROUTES_PROVIDER` | `google` if the key is set, else `haversine` | |
| `GOOGLE_ROUTES_API_KEY` | – | required for `google` |
| `ROUTES_TRAVEL_MODE` | `DRIVE` | or `TWO_WHEELER` |
| `ROUTES_TRAFFIC_AWARE` | `false` | `true` = Advanced SKU |
| `ROUTES_TIMEOUT_MS` | `4000` | per Google call |
| `ROUTES_CACHE_TTL_SECONDS` / `ROUTES_CACHE_MAX_ENTRIES` | `900` / `5000` | trip cache (per process) |
| `ROUTES_FAILURE_THRESHOLD` / `ROUTES_FAILURE_COOLDOWN_SECONDS` | `3` / `60` | circuit breaker |
| `ROUTES_LIVE_REFRESH_SECONDS` / `ROUTES_LIVE_REFRESH_METERS` | `90` / `300` | live route refresh |
| `ROUTE_AVERAGE_SPEED_KMPH` / `ROUTE_DISTANCE_FACTOR` | `22` / `1` | straight-line fallback |

## Code

- `src/modules/locations/google-routes-estimator.ts`: the Google client.
- `src/modules/locations/resilient-route-estimator.ts`: cache, fallback, breaker.
- `src/modules/locations/live-route.service.ts`: per-ride live route cache.
- `src/modules/locations/locations.module.ts`: picks the estimator from `ROUTES_PROVIDER`.
- `src/modules/rides/ride-route.service.ts`: `GET /rides/:id/route`.
- `src/common/cache/ttl-cache.ts`: shared LRU/TTL cache (moved from places).

## Tests

- `src/modules/locations/routes.spec.ts`: Google request/response/error mapping
  (mocked `fetch`), cache, fallback and breaker, live-route refresh rules.
- `test/routes.e2e-spec.ts` (`npm run test:e2e -- test/routes.e2e-spec.ts`):
  the whole flow with Google replaced by a fake: road-priced estimate, cached
  booking, route stored on the ride, APPROACH → none while arrived → TRIP,
  access control, and the outage fallback + breaker.
- The test environment (`NODE_ENV=test`) never loads `.env`, so no test calls Google.

## Notes

- Rides booked before this change have no `routePolyline`; apps draw them straight.
- Caches are per process. With several API nodes, each keeps its own, which
  costs a few extra calls, not wrong answers.
- The live route starts where the driver was when it was computed; the driver
  marker moves on between refreshes (≤ 300 m / 90 s).
