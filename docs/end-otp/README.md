# End-of-trip OTP

A trip is ended the way it is started: with a code the rider reads to the
driver. The start OTP already existed (Phase 2); this adds the end code, a
"rider not responding" fallback for the driver, and ops completion from the
admin panel.

Circuits are **not** covered: they end through `POST /circuit-rides/:id/complete`
(stops done, package pricing). `request-end`, `complete` and
`complete-without-otp` answer a circuit with `409 CIRCUIT_COMPLETE_REQUIRED`.

## Flow

```
RIDE_STARTED ──driver: POST /rides/:id/request-end──► RIDE_STARTED + endRequestedAt
                                                       │ rider's app shows the END code
                                                       │ rider is pushed "Share your end-of-trip OTP"
                    ┌──────────────────────────────────┤
                    │ driver: POST /rides/:id/complete {otp}   → COMPLETED (OTP)
                    │ driver: POST /rides/:id/cancel-end       → RIDE_STARTED, request withdrawn
                    │ driver: POST /rides/:id/complete-without-otp {reason}
                    │          after RIDE_END_OVERRIDE_WAIT_SECONDS → COMPLETED (DRIVER_OVERRIDE)
                    │ admin:  POST /admin/rides/:id/complete {note} → COMPLETED (ADMIN)
                    └ an open SOS on the ride: no code, no wait     → COMPLETED (SOS)
```

The ride **stays `RIDE_STARTED`** while it waits for the code, so the state
machine, SOS rules, rooms and every status screen are unchanged. What changes
is on the ride document and in the two views.

## The fare stops when the driver asked, not when the code was typed

`endRequestedAt` is set once, on the first request. At completion the fare is
priced with `completedAt = endRequestedAt`: the duration is
`endRequestedAt − startedAt`, and the trip meter's GPS trail is cut at that
instant (`DriverLocationService.tripTrail(…, until)`), so neither the time nor
the kilometres driven while waiting for the rider's code are charged. The
driver's position is saved as a trail point at the request, so the meter
measures up to where the trip ended.

`ride.completedAt` equals `endRequestedAt`; `endOtpVerifiedAt` is when the code
was actually typed.

Asking again while the code is valid changes nothing. After the code expired a
fresh one is minted but `endRequestedAt` stays. "Continue trip" (`cancel-end`)
clears the request; a later request starts from a new moment, and the fare is
re-measured over the whole trail, so withdrawing and asking again gains nobody
anything.

## Code rules

Same as the start OTP, with the same env vars (`RIDE_OTP_TTL_MINUTES`,
`RIDE_OTP_MAX_ATTEMPTS`) and error codes:

| Situation | Response |
|---|---|
| Wrong code | `400 RIDE_OTP_INVALID`, `data.attemptsRemaining` |
| Attempts used up | `400 RIDE_OTP_TOO_MANY_ATTEMPTS`; the code is rotated, the rider's app gets the new one (`ride.otp_refreshed`, `otp.purpose = END`) |
| Expired | `400 RIDE_OTP_EXPIRED`; rotated the same way |
| Completing before asking | `409 RIDE_END_OTP_REQUIRED` (`data.endRequested`) |

The code is stored in clear with `select: false` (`endOtpCode`) because the
rider's app shows it, is scoped to one ride, expires, is attempt-limited and is
removed when used. The completion transition is guarded on the exact code that
was verified, so a rotation or a double submit cannot complete twice. Support
never sees the code (admin detail has attempts/expiry/verified-at only), and the
driver's view never carries it.

## "Rider not responding"

`POST /rides/:id/complete-without-otp { reason }` (5–240 characters):

* `409 RIDE_END_NOT_REQUESTED` unless the driver asked to end the trip first.
* `409 RIDE_END_OVERRIDE_TOO_EARLY` until `RIDE_END_OVERRIDE_WAIT_SECONDS`
  (default 120) after `endRequestedAt`; `data.availableAt`/`retryAfterSeconds`.
  The driver's view has `endOtp.overrideAvailableAt` so the app counts down.
* Completes with `completionMode = DRIVER_OVERRIDE`, the reason saved as
  `completionNote`, and is flagged `needsReview`.

## Far from the drop-off

On the first request the driver's last known position is compared with the
booked destination (`RIDE_END_FAR_RADIUS_METERS`, default 500 m). The distance
and a `farFromDestination` flag are stored (`endCheck`). It is a flag for
support, never a block: riders change destination mid-trip. An unknown driver
position is **not** flagged. The flag is not exposed to the apps.

## SOS

If an SOS is open on the ride, `complete` needs no code and
`complete-without-otp` needs no wait; the ride completes with
`completionMode = SOS`. Nobody should negotiate for a code during an emergency.

## Admin

* `POST /admin/rides/:id/complete { note }` (3–240): ends a stuck trip, priced
  like any other end (to `endRequestedAt` when there is one, else to now);
  `completionMode = ADMIN`; audited as `ride.complete`; `409` if the ride is
  not in progress or is a circuit.
* `GET /admin/rides?needsReview=true`: trips that ended in `DRIVER_OVERRIDE`,
  `ADMIN` or `SOS`, or far from the drop-off.
* List items and detail carry `end { requestedAt, mode, note, farFromDestination,
  distanceToDestinationMeters, needsReview }` (detail adds `otpAttempts`,
  `otpExpiresAt`, `otpVerifiedAt`).
* Panel: Rides → "Needs review" filter and badges; ride detail has the "End of
  trip" section, a review banner and "Complete ride".

## Views and events

| | Customer view | Driver view |
|---|---|---|
| `otp` | `{ code, expiresAt, purpose: "START" \| "END" }` (END while `RIDE_STARTED` and the end was requested) | never |
| `endOtp` | – | `{ requestedAt, expiresAt, overrideAvailableAt }` while waiting |
| `endRequestedAt`, `completionMode` | yes | yes |

Realtime (both participants get their own view; rooms are kept):

| Event | When |
|---|---|
| `ride.end_requested` | the driver asked to end the trip (customer's view carries the code) |
| `ride.end_cancelled` | the driver took it back |
| `ride.otp_refreshed` | the end code was rotated (customer only receives the new code) |

Push: `RIDE_END_OTP` ("Share your end-of-trip OTP", high priority, never
containing the code), planned in `notification-plan.ts` from the
`ride.end_requested` domain event.

## Configuration

| Env | Default | |
|---|---|---|
| `RIDE_END_OTP_ENFORCED` | `true` | `false`: `POST /complete` works without a code (`completionMode = NOT_REQUIRED`). For rolling out while old driver apps are still in the field; the old e2e suites run with it `false`. |
| `RIDE_END_OVERRIDE_WAIT_SECONDS` | `120` | wait before "rider not responding" |
| `RIDE_END_FAR_RADIUS_METERS` | `500` | drop-off distance that is flagged |

## Rollout

1. Ship the API with `RIDE_END_OTP_ENFORCED=false`, then the driver and rider
   apps. Old driver apps keep completing as before; new ones use the code flow.
2. When the old driver app is gone, set `RIDE_END_OTP_ENFORCED=true`.

## Tests

* `test/end-otp.e2e-spec.ts` — request/code/rotation/expiry, fare frozen at the
  request, far flag, withdrawing, "rider not responding" (early/late/validation),
  SOS bypass, admin completion, who can see what.
* Phase 2/3/4/5/7 and payments-v2 e2e suites run with `RIDE_END_OTP_ENFORCED=false`.
* Flutter: `test/features/rides/end_otp_test.dart`.
