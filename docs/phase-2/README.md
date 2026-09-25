# Phase 2 — Basic ride booking

A customer picks pickup, destination and ride type, sees a server-priced
estimate and books. The backend matches the nearest eligible driver. The
driver accepts, arrives, enters the customer's OTP, starts and completes the
ride. Both apps follow the ride by **polling**. There are no WebSockets,
Redis or live maps yet; those arrive in Phase 3.

| Part   | New in Phase 2                                                                 |
| ------ | ------------------------------------------------------------------------------ |
| API    | `ride-types`, `pricing`, `locations`, `matching`, `rides` modules; admin rides/pricing |
| Mobile | `lib/features/rides/`: booking flow, live ride screens, driver dashboard, history |
| Admin  | Rides list/detail with status history, Pricing editor, ride KPIs on Dashboard  |

## Run locally

The setup is the same as Phase 1 (see `docs/phase-1/README.md`). The ride types (Bike/Auto/Cab) and their
launch tariffs are seeded automatically on first boot and never overwritten
afterwards. New settings are listed in `.env.example` under *Ride booking* and
*Matching*. The defaults work for development.

**Two-device test.** Use one customer account and one approved driver account whose active vehicle
type matches the ride type you book:

1. Driver: **Home → Your location** → pick *ISKCON Vrindavan* → switch **online**.
2. Customer: **Home** → pickup *Prem Mandir* → destination *Banke Bihari
   Temple* → **See ride options** → *Auto* → **Confirm ride** → **Confirm booking**.
3. Driver: the request appears within about 4 s → **Accept** → **I've arrived**.
4. Customer: the 4-digit OTP appears → read it to the driver.
5. Driver: enter the OTP → **Start ride** → **Complete ride**.
6. Admin: **Rides** → open the ride → the full status history is shown.

Locations are a fixed list of test places in Vrindavan, Mathura and Govardhan
(`lib/features/rides/domain/test_places.dart`) until the Maps SDK and GPS arrive.

## Tests

```bash
cd tirvona/Tirvona_ride
npm test                                        # + fare calculator, Haversine, state machine, OTP
npm run test:e2e -- test/phase2.e2e-spec.ts     # the Phase 2 definition of done, 28 cases
cd ../../tirvona-ride-app && flutter test       # + ride routing, models, polling source
```

`phase2.e2e-spec.ts` runs the whole lifecycle over HTTP against in-memory MongoDB and
checks every item on the Phase 2 definition-of-done list. That includes correct fare, nearest correct-type driver,
wrong OTP rejected, unauthorised actions rejected, two concurrent accepts with
exactly one winner, busy drivers not re-offered, driver available after
completion, history, admin inspection and pricing changes. It also covers
no-driver timeouts, assignment timeouts and driver heartbeats.

## API

All under `/api/v1`, bearer token required.

| Method | Path                         | Access           | Notes |
| ------ | ---------------------------- | ---------------- | ----- |
| GET    | `/ride-types`                | any role         | bookable types only |
| POST   | `/rides/estimate`            | CUSTOMER         | `{ rideType, pickup, destination }` |
| POST   | `/rides/estimate/all`        | CUSTOMER         | `{ pickup, destination }` → one quote per type |
| POST   | `/rides`                     | CUSTOMER         | books; server re-prices; 409 `RIDE_ALREADY_ACTIVE` |
| GET    | `/rides`                     | CUSTOMER, DRIVER | history, `?page&limit&status` |
| GET    | `/rides/active`              | CUSTOMER, DRIVER | in-flight ride or `null` |
| GET    | `/rides/requests`            | DRIVER           | poll for offers; also the driver heartbeat |
| GET    | `/rides/:id`                 | owner customer / current driver | poll; OTP only to the customer at `DRIVER_ARRIVED` |
| POST   | `/rides/:id/cancel`          | CUSTOMER, DRIVER | `{ reason? }` |
| POST   | `/rides/:id/accept`          | DRIVER           | atomic; losers get 409 |
| POST   | `/rides/:id/reject`          | DRIVER           | `{ reason? }`; ride re-matched |
| POST   | `/rides/:id/arrived`         | DRIVER           | issues the OTP |
| POST   | `/rides/:id/start`           | DRIVER           | `{ otp }` |
| POST   | `/rides/:id/complete`        | DRIVER           | records final fare, frees driver |
| PATCH  | `/drivers/availability`      | DRIVER           | `{ isOnline, latitude?, longitude?, vehicleId? }` |
| PATCH  | `/drivers/location`          | DRIVER           | `{ latitude, longitude }` |
| GET    | `/drivers/dashboard`         | DRIVER           | duty status, today's rides/fares, current ride |
| GET    | `/admin/rides`               | ADMIN            | `?status&rideType&search&page&limit` |
| GET    | `/admin/rides/:id`           | ADMIN            | ride, customer, driver, status history |
| POST   | `/admin/rides/:id/cancel`    | ADMIN            | `{ reason }` for stuck rides |
| GET    | `/admin/pricing`             | ADMIN            | every ride type + tariff |
| PATCH  | `/admin/pricing/:rideType`   | ADMIN            | any of `baseFare, perKmRate, perMinuteRate, minimumFare` |
| PATCH  | `/admin/ride-types/:rideType`| ADMIN            | `{ isActive, displayName, description, sortOrder }` |

## Design notes

**Ride lifecycle.** `SEARCHING → DRIVER_ASSIGNED → DRIVER_ACCEPTED → DRIVER_ARRIVED →
RIDE_STARTED → COMPLETED`. Other exits: `DRIVER_ASSIGNED → SEARCHING` when the driver
rejects, times out or goes offline, `→ CANCELLED` before the trip starts, and
`SEARCHING → NO_DRIVER_AVAILABLE` when the search window ends. The edges are
listed in `rides/ride-state-machine.ts`. Every write goes through
`RideTransitionService`, which runs a conditional `findOneAndUpdate` on
`{ _id, status: from, …guards }`. When two requests race, MongoDB lets exactly one win and
the other gets a 409. Each transition also appends a row to
`ride_status_history`.

**Data-level guards.** Partial unique indexes allow one active ride per customer and
one per driver. Matching reserves a driver with a compare-and-set on
`{ isAvailable: true, currentRideId: null }`. As a result, a driver is never offered two rides
and never receives a new one while busy.

**Pricing.** The fare is `base + perKm × km + perMinute × min`, floored at the minimum
fare and rounded to the nearest ₹1. The calculation is done in paise. The server
prices every estimate and every booking, and request bodies cannot carry a fare
(non-whitelisted fields are rejected). Each ride snapshots the tariff and its version. The final fare
is computed from that snapshot, so admin price changes only affect new
bookings.

**Locations.** Rides and pricing depend only on the `RouteEstimator` interface.
Phase 2 binds a Haversine implementation: straight-line distance, with
duration derived from `ROUTE_AVERAGE_SPEED_KMPH`. A maps provider replaces it
by changing one binding in `LocationsModule`.

**Matching.** `$geoNear` over a 2dsphere index finds approved, online,
available and unreserved drivers with the right vehicle type, within
`MATCHING_RADIUS_KM`, who were heard from in the last
`MATCHING_DRIVER_HEARTBEAT_SECONDS`. The nearest driver wins. The first attempt runs inline on
booking. A background sweep (`MATCHING_SWEEP_INTERVAL_MS`) retries open
searches and applies the timeouts. Every sweep step is idempotent, so several API
instances are safe. Reads also apply overdue timeouts, so polling clients never see
stale state.

**OTP.** The 4-digit OTP is issued on arrival and shown only to the ride's customer. It
expires after `RIDE_OTP_TTL_MINUTES` and allows `RIDE_OTP_MAX_ATTEMPTS` wrong tries.
On expiry or lockout it rotates, and the customer app picks up the new code on its next poll.
It is cleared once verified.

**Polling is isolated.** Flutter screens consume
`RideUpdatesSource.watchRide / watchDriverRequests`. The Phase 2
`PollingRideUpdatesSource` fetches immediately, polls every 3 s for a ride and every 4 s for requests,
backs off on errors, pauses in the background and stops at terminal states. Phase 3 replaces
it with a WebSocket implementation behind the same interface.

## Deliberately not in Phase 2

Realtime transport, live driver marker, Redis GEO, payments, earnings ledger,
push notifications, ratings, SOS/safety, promo codes, zones and cancellation
fees. The Driver **Earnings** tab and the admin **Customers** page stay placeholders.
