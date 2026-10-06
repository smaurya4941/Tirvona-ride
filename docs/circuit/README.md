# Tirvona Circuit

A **circuit** is a predefined multi-stop ride package: the customer books a vehicle and driver for a fixed package
price that includes a set time and distance, visiting stops Admin chose, in Admin's order.

```
NORMAL RIDE   pickup → destination
CIRCUIT RIDE  pickup → stop 1 → stop 2 → … → last stop → completion
```

Circuit is **not a separate backend**. It is a domain capability inside the ride platform:

| Concept          | Where                                           | What it is                                                         |
| ---------------- | ----------------------------------------------- | ------------------------------------------------------------------ |
| `CircuitPackage` | `src/modules/circuit-packages`, `circuit_packages` | What Admin sells and configures. Lives for months.                 |
| `CircuitRide`    | a `rides` document with `kind: "CIRCUIT"`       | What a customer booked: `ride.circuit` is a frozen package snapshot. |
| `CircuitStop`    | `ride.circuit.stops[]`                          | One destination of a booked circuit, with its own lifecycle.       |

Because a circuit **is** a ride, it reuses — unchanged — authentication, matching (plus a circuit-eligibility filter),
the OTP start, the status state machine, realtime rooms, payments (Razorpay and cash), earnings and commission,
cancellations, ratings, SOS / share ride, notifications and the admin ride views.

## Authority

Flutter displays and sends commands. NestJS validates the package, availability, vehicle, capacity and pickup;
calculates the route, the estimate, the timer, stop progression and the final fare. MongoDB is the source of truth.
Admin configures packages. No client can set a status, a stop, a fare or a timer: there is no `PATCH` on a circuit.

## Package lifecycle

`DRAFT → ACTIVE ⇄ INACTIVE → ARCHIVED` (`DRAFT → ARCHIVED` too). Only ACTIVE packages are visible and bookable.
Publishing (→ ACTIVE) runs every rule in `circuit-package.rules.ts#publishProblems` (name, ≥ 2 stops in order, each
picked from the Places provider with a place id and coordinates, no duplicate place, included distance and
duration > 0, valid ride types, **a price for every allowed vehicle** (price > 0, non-negative extra rates, none for a
vehicle that is not allowed), passenger limit 1–8, a valid schedule). A live package can be edited only into another
publishable state.

### Pricing per vehicle

Each allowed vehicle has its own price; the allowance is shared, because the route decides how far and how long a
circuit runs:

| Field (package)                 | Scope                    | Meaning                                                    |
| ------------------------------- | ------------------------ | ---------------------------------------------------------- |
| `pricing.includedDistanceMeters` | every vehicle            | Included distance                                          |
| `pricing.includedDurationSeconds` | every vehicle          | Included time                                              |
| `vehiclePricing[].basePrice`    | one ride type            | Package price with that vehicle                            |
| `vehiclePricing[].extraDistanceRatePerKm` | one ride type  | Per started extra km                                       |
| `vehiclePricing[].extraDurationRatePerHour` | one ride type | Per started extra 15 min (÷ 4)                            |

API: `PATCH /admin/circuit-packages/:id {pricing: {includedDistanceKm, includedDurationHours}, rideTypes, vehiclePricing:
[{rideType, basePrice, extraDistanceRatePerKm, extraDurationRatePerHour}]}`. `vehiclePricing` replaces every price when
sent; a duplicate ride type or one not in `rideTypes` is `400 CIRCUIT_PACKAGE_INVALID`. Removing a vehicle from
`rideTypes` drops its price. A draft may leave a vehicle unpriced (the checklist says "Set a price for BIKE"); a live
package cannot gain an unpriced vehicle. Price changes bump the revision and are audited as
`changes.vehiclePricing {from, to}`.

Customers get `vehicles[]` cheapest first, each with its full tariff in `vehicles[].pricing`; the package-level
`pricing` is the cheapest vehicle's tariff (the "from" price on lists). The estimate and the booking snapshot
(`ride.circuit.pricing`) use the chosen vehicle's tariff, so billing, warnings and receipts are unchanged.

Migration: packages saved with one price (`pricing.basePrice`) are moved on boot by `CircuitPackagesMigration` —
that price becomes every allowed vehicle's price and the old fields are removed. It is idempotent and leaves the
revision alone (customers are quoted exactly what they were before). A package that was ever booked (`hasBookings`) is archived, never
deleted; only an unused draft can be deleted.

Stops are resolved by the server from the place id (`PlacesService.resolve`) — name, address and coordinates are
never taken from the client. Every create / update / status / cover change is in the audit log
(`targetType: CIRCUIT_PACKAGE`) with old → new values per field and the admin's reason.

Availability: weekdays (0 = Monday), opening hours `[opensAt, closesAt)` in `APP_TIME_ZONE` (may cross midnight),
optional season `validFrom`–`validUntil` (inclusive dates). Seats offered = `min(package maxPassengers, ride type
seatCapacity)`.

`POST /admin/circuit-packages/:id/route-preview` routes stop → stop (and from an optional reference origin) through
the shared Routes estimator and warns when the included distance is lower than the route.

## Booking

1. `POST /circuit-rides/estimate {packageId, rideType, pickup, passengers}` — validates package status,
   availability, vehicle, capacity, pickup within `CIRCUIT_MAX_PICKUP_DISTANCE_KM` of stop 1 and the service zone;
   routes pickup → stop 1 → … → last stop; returns the chosen vehicle's package price, its rules for extras, and `estimatedTotal`
   (package + extras the planned route already implies). **Never the final fare.**
2. `POST /circuit-rides` (same body + `Idempotency-Key` header or `idempotencyKey`) — re-quotes from scratch, then
   inserts the ride in `SEARCHING` with `kind: CIRCUIT` and the frozen snapshot: package code / revision, name, stops,
   pricing, cancellation policy. A repeated key returns the first booking (unique index
   `uniq_circuit_booking_key`); the one-active-ride-per-customer index still applies.
3. Matching is the normal dispatcher with `circuitEligible: {$ne: false}` added for circuits. Admin can switch a
   driver off for circuits: `PATCH /admin/circuit-rides/drivers/:driverId/eligibility` (audited). The assigned driver
   is reserved (`currentRideId`, `isAvailable: false`) until the circuit completes or is cancelled.

The package price is stored in the ride's normal fare shape (`fare.baseFare`, `fare.estimatedFare`,
`pricingVersion = package revision`) so payments, cancellation fees and receipts need no circuit code.

## Running a circuit

Accept / arrived / start (OTP) / cancel are the normal ride commands (aliases under `/circuit-rides/:id/…`).
**The circuit timer is `startedAt`** — set when the driver starts with the customer's PIN. Driving, waiting, traffic
and the customer's time at each stop all count towards the included duration.

Stop lifecycle, owned by the server, fixed order:

```
UPCOMING → ARRIVING (current stop) → ARRIVED → WAITING (optional) → COMPLETED
                                          └── SKIPPED (only by Admin)
```

| Command (driver)                          | From → to                  | Notes                                                                    |
| ----------------------------------------- | -------------------------- | ------------------------------------------------------------------------ |
| `POST /circuit-rides/:id/stops/:n/arrive`   | ARRIVING → ARRIVED         | Driver must be within `CIRCUIT_STOP_ARRIVAL_RADIUS_METERS` when a fresh GPS fix exists; no fix = allowed (GPS loss must not strand a circuit), recorded as such. |
| `POST …/stops/:n/waiting`                   | ARRIVED → WAITING          | Customer is visiting.                                                    |
| `POST …/stops/:n/complete`                  | ARRIVED/WAITING → COMPLETED | Next stop becomes ARRIVING; `currentStopOrder` advances.                |
| `POST …/stops/:n/blocked`                   | opens `circuit.exception`  | No progress until Admin resolves it.                                     |
| `POST /circuit-rides/:id/complete`          | RIDE_STARTED → COMPLETED   | Only after every stop is done and no exception is open.                  |

Every command is a single conditional update on the ride (status, `currentStopOrder`, stop status, no open
exception), so it is **repeat-safe**: a retry after a lost response returns the same state, never a second change.
`POST /rides/:id/complete` refuses circuits (`CIRCUIT_COMPLETE_REQUIRED`). The live route (`GET /rides/:id/route`)
leads to the current stop.

Admin interventions (all audited, all in the circuit timeline):

- `POST /admin/circuit-rides/:id/exceptions/resolve {resolution: CONTINUE | SKIP_STOP, note}`
- `POST /admin/circuit-rides/:id/end {reason}` — ends a started circuit: open stops are SKIPPED and it is billed
  for what it used, exactly like a driver completion (`settlement.completedBy = ADMIN`).
- `POST /admin/circuit-rides/:id/cancel` — before the start only (the normal admin cancel).

## Final fare (`circuit-pricing.ts`)

```
final = package price
      + ceil(max(0, used km − included km)) × rate per km
      + ceil(max(0, used time − included time) / 15 min) × (rate per hour ÷ 4)
```

rounded to whole rupees. Used time is server-timed (`startedAt` → completion); used distance is the GPS trip trail
(`measureTrip`), or the booked route when the trail is unreliable. Worked example (₹600 · 30 km · 5 h, ₹15/km,
₹50/h): 29 km / 4 h → ₹600; 35 km / 4 h → ₹675; 29 km / 6 h → ₹650; 35 km / 6 h → ₹725.

Completion writes `fare.finalFare`, the frozen `fare.final` (`mode: "package"`, components:
`baseFare` = package, `distanceCharge`/`timeCharge` = extras) and `circuit.settlement`; `paymentStatus` becomes
`PENDING`. From there it is the normal payment flow: online or cash, `PAYMENT_PENDING` until verified (a customer
who refuses the extra stays `PENDING` and shows up in Admin's "Payment pending" filter), then earnings and
commission per ride type, then rating. Promotions are not applied to circuits in this version.

## Usage monitor and warnings

`CircuitMonitorService` runs every `CIRCUIT_MONITOR_INTERVAL_MS`: measures the distance so far (never decreasing),
pushes `circuit.usage`, and sends each warning **once per circuit** (a conditional update on
`circuit.warnings.<flag>` decides, safe across instances): 30 min left, 10 min left, time used up, 80 % of distance,
distance used up. Warnings go to both apps as realtime events and push notifications (`CIRCUIT_WARNING`).

## Realtime

Every circuit event carries the recipient's full ride view (same as `GET /circuit-rides/:id`), so apps just render it:
`circuit.started`, `circuit.stop.arrived`, `circuit.stop.waiting`, `circuit.stop.completed`, `circuit.next_stop`,
`circuit.stop.blocked`, `circuit.stop.skipped`, `circuit.exception.resolved`, `circuit.usage`,
`circuit.time_warning`, `circuit.distance_warning`, `circuit.completed`. Normal `ride.*` status events still fire.
After a reconnect the app re-reads the circuit over REST (the server is authoritative; local state is never trusted).

Push notification types: `CIRCUIT_STOP`, `CIRCUIT_WARNING`, `CIRCUIT_EXCEPTION`; ride notifications mention the
package name for circuits.

## Admin panel

Sidebar **Circuits**: Circuit packages (list, six-step editor that saves as you go — the first Next creates the draft, every later step change saves only what changed, a live package asks for a reason before saving, the last step shows Publish (or Save changes) instead of Next, and leaving with unsaved edits is warned; basics, stops from the maps search with reorder /
replace / remove and a map, route preview, vehicles & passengers, pricing (shared included distance / time, then one card per allowed vehicle with its price, extra rates, a worked example and "Copy to all vehicles"), availability; the package list shows each vehicle's price; cover
image; publishing checklist; change history), Circuit bookings (filters: status, package, city, payment, dates,
search), booking detail (route with stop states, map, usage bars, financials, people, merged status + stop timeline,
resolve / end / cancel), Live circuits (map + list, 5 s refresh), Circuit reports (bookings, revenue split into
package / extra distance / extra time, operations averages, most booked / highest revenue / cancellation rate per
package). Driver detail has a "Circuit rides" eligibility toggle.

## Apps

Customer: Home → **Ride Circuit** card → package list ("from ₹…" when vehicles differ) → package details (stops, what
is included, each vehicle with its own price and extra rates, schedule, cancellation policy) → booking (pickup, vehicle
with its price, passengers, server estimate, "Confirm & Book" with an
idempotency key) → the normal ride screen, which for a circuit shows the package, live time / distance gauges
(ticking from the server's elapsed time), the stop timeline, the current stop on the map, warnings as snackbars, and
an itemised final bill; then the normal payment and rating screens. History shows the package and its stops.

Driver: the request card shows the whole circuit (package, stops, price, passengers). After the start the ride
screen switches to the dedicated circuit panel: remaining time and distance, current stop with Navigate, one clear
action at a time (Arrived → Continue / Customer is visiting → Continue …, "Can't reach this stop"), support banner
while an exception is open, and "Complete circuit" after the last stop.

## Cover images

`GET /admin/circuit-packages/cover-rule` (`cover-image.ts`): landscape PNG / JPEG / WEBP, at least 640 × 360 px, up to
5 MB, height 0.4–1.1 × width. The panel checks before uploading; the server re-checks the real bytes. Stored in
MongoDB with the package; served publicly (immutable-cached by version) at `/circuit-packages/:id/cover`.

## Configuration

| Env                                  | Default | Meaning                                                                    |
| ------------------------------------ | ------- | -------------------------------------------------------------------------- |
| `CIRCUIT_STOP_ARRIVAL_RADIUS_METERS` | 1000    | How close the driver must be to mark a stop arrived (0 = don't check).     |
| `CIRCUIT_MONITOR_INTERVAL_MS`        | 30000   | Usage measuring + warnings period (0 = off).                               |
| `CIRCUIT_MAX_PICKUP_DISTANCE_KM`     | 60      | Furthest straight-line pickup from stop 1.                                 |

## Edge cases

| Case                                   | Behaviour                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------- |
| Customer cancels before / after assignment, after arrival | Normal cancellation policy and fees (`/rides/:id/cancel`).                 |
| Circuit started                        | Cannot be cancelled; Admin can end it early (billed for usage).                             |
| Driver cancels / rejects / times out   | Normal re-matching; drivers switched off for circuits are never offered one.               |
| No driver                              | `NO_DRIVER_AVAILABLE` after the search window; customer can book again.                     |
| Customer doesn't appear                | Driver cancels with the normal reason/fee rules.                                            |
| Time / distance exceeded               | Warnings at 30 / 10 min and 80 / 100 %; extras billed at completion.                        |
| Stop inaccessible                      | Driver reports it; progress stops; Admin continues or skips.                                |
| GPS lost                               | Stop arrival allowed without a fresh fix; billed distance falls back to the booked route if the trail is unreliable. |
| Driver / customer network loss, app crash | Commands are repeat-safe; apps re-sync the server snapshot on reconnect / resume.        |
| Payment fails / extra refused          | `paymentStatus` stays `PENDING`/`FAILED`; Admin filter "Payment pending"; never set by a client. |
| Admin edits the package mid-circuit    | No effect: the ride uses its snapshot (`packageRevision`).                                  |
| Double tap on "Confirm & Book"         | Same `Idempotency-Key` → same booking.                                                       |

## Tests

- `src/modules/circuit-rides/circuit-pricing.spec.ts` — the fare examples, started-km / 15-min blocks, warnings.
- `src/modules/circuit-packages/circuit-package.rules.spec.ts` — availability, publishing, capacity, distance warning.
- `src/modules/circuit-rides/circuit-ride.types.spec.ts`, `src/modules/locations/polyline.spec.ts`.
- `test/circuit.e2e-spec.ts` — admin build & publish & audit, customer list/estimate/rules, idempotent booking,
  snapshot vs later price change, OTP start, stop order / radius / repeat-safety, blocked stop resolved by Admin,
  ₹725 completion, payment, history, notifications, monitor warnings once, live board, end early, eligibility,
  report.
- Flutter `test/features/circuit/circuit_test.dart` — models, notices, formatting, widgets and the driver panel.

Not in this version (by design): custom or flexible stops, customer-skipped stops, promotions on circuits,
scheduled circuits, package versioning collection, configurable circuit-specific cancellation amounts (the normal
cancellation policy applies).
