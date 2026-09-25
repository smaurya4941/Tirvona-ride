# Phase 3 — Real-time layer

Phase 2's polling is gone. Ride state changes and driver GPS now reach both
apps over a WebSocket, and the customer sees the driver move on a live map.
**MongoDB is still the source of record, NestJS still decides everything, and
there is no Redis or Docker.**

```
Customer app ─┐                                   ┌─ Driver app
  REST (actions, recovery)                          REST (actions, recovery)
  WebSocket /realtime  ◄──── NestJS ────►  WebSocket /realtime (+ GPS up)
                               │
                            MongoDB  (rides, drivers, throttled latest location,
                                      status history, coarse checkpoints)
```

| Part    | New in Phase 3 |
| ------- | -------------- |
| API     | `realtime/` (Socket.IO gateway, socket auth, room access, publisher, location relay); `locations/` driver location ingest + checkpoints; `RideEventsService`; reactive dispatch; `stateVersion` on rides |
| Mobile  | `core/realtime/` (one socket for the app), `core/location/` (GPS service), live map (`RideMap`), realtime `RideUpdatesSource`, GPS-based duty, app-restart recovery |
| Admin   | Ride detail shows location checkpoints; dashboard shows drivers *matchable now* |

## Responsibility split

| REST | WebSocket | MongoDB |
| ---- | --------- | ------- |
| Login, profile, book, accept, reject, arrived, start, complete, cancel, history, **current state for recovery** | Ride events, incoming offers, driver GPS, live tracking | Users, drivers, vehicles, rides, status history, availability, latest location, checkpoints |

WebSocket never changes business state. Every ride event is emitted by
`RideEventsService`, which `RideTransitionService` (the single status-write
point) calls **after** the compare-and-set commits — so an event always means
"this already happened", and every transition produces exactly its event.

## Socket contract

Namespace `/realtime`, WebSocket transport only. Authenticate with the normal
access token: `io(url + "/realtime", { transports: ["websocket"], auth: { token } })`.

Handshake failures arrive as `connect_error` whose `message` is a code:
`AUTH_UNAUTHORIZED`, `AUTH_TOKEN_EXPIRED` (refresh, then reconnect),
`AUTH_FORBIDDEN` (admins), `USER_BLOCKED`. When the token behind an open
socket expires the server emits `session.expired` and disconnects.

**Rooms.** `user:{userId}` — every socket of a user (driver offers, session
events). `ride:{rideId}` — the ride's customer while it is active and its
driver from acceptance until it ends. A driver who is only *offered* a ride is
not a member. On every (re)connect the server restores the socket's rooms and
emits `session.ready { userId, role, rideIds, recovered }`.

**Client → server** (all acknowledged with `{ ok: true, … }` or `{ ok: false, code, message }`):

| Message | Body | Notes |
| ------- | ---- | ----- |
| `ride.join` | `{ rideId }` | `RIDE_NOT_FOUND` (not yours / missing — indistinguishable), `RIDE_NOT_ACTIVE` |
| `ride.leave` | `{ rideId }` | |
| `driver.location` | `{ latitude, longitude, heading?, speed?, accuracy?, recordedAt?, rideId? }` | drivers only; `RIDE_MISMATCH`, `DRIVER_OFFLINE`, `LOW_ACCURACY`, `STALE_FIX`, `RATE_LIMITED`, `VALIDATION_FAILED` |

**Server → client.** One envelope for all ride events:

```json
{ "event": "ride.driver_accepted", "rideId": "…", "status": "DRIVER_ACCEPTED",
  "stateVersion": 3, "timestamp": "…", "data": { "driverId": "…" }, "ride": { …recipient's own view… } }
```

`ride` is exactly what `GET /rides/:id` returns *to that recipient* — the
customer's view includes the OTP at `DRIVER_ARRIVED`, the driver's never does.
Clients keep the snapshot with the highest `stateVersion`.

| Event | Customer | Driver | When |
| ----- | :------: | :----: | ---- |
| `ride.requested` | ✓ | ✓ offer (user room) | booking created / ride assigned to this driver |
| `ride.driver_assigned` | ✓ | | a driver was matched |
| `ride.searching` | ✓ | | the assigned driver rejected / timed out / went offline |
| `ride.offer_withdrawn` | | ✓ | that driver's offer ended (no ride view) |
| `ride.driver_accepted` | ✓ | ✓ | |
| `ride.driver_arriving` | ✓ | ✓ | first fix within `DRIVER_ARRIVING_RADIUS_METERS` — exactly once |
| `ride.driver_arrived` | ✓ (+OTP) | ✓ | |
| `ride.otp_refreshed` | ✓ | | OTP rotated after expiry / too many wrong tries |
| `ride.started` | ✓ | ✓ | |
| `ride.location_updated` | ✓ | | every accepted fix; volatile, `data` only |
| `ride.completed` / `ride.cancelled` | ✓ | ✓ | room closes afterwards |
| `ride.no_driver_available` | ✓ | | search window ended |

## Driver location without Redis

```
GPS → Flutter DriverLocationService → driver.location → DriverLocationService (NestJS)
        ├─ relay every accepted fix → ride:{id} (volatile) → customer map
        ├─ driver_profiles.currentLocation  (≤ every 15 s, or after a 75 m move)
        └─ driver_location_checkpoints      (lifecycle points + ≤ 1 trail sample / 60 s)
```

* **No GPS-ping explosion.** A driver streaming every 3 s causes one profile
  write per 15 s and one trail checkpoint per minute. The Phase 3 e2e suite
  asserts both.
* **Freshness.** Matching requires `locationUpdatedAt` within
  `DRIVER_LOCATION_STALE_SECONDS` (default 60). A driver whose app dies stays
  `isOnline` but silently stops being matchable. Going online needs a fresh
  location; the app heartbeats a stationary position every 10–20 s.
* **Arriving** is detected server-side and claimed with a conditional update
  (`arrivingNotifiedAt`), so it fires once even across instances.
* The customer's ride view carries `driver.location` (last known), so the map
  shows the driver immediately after opening or reconnecting.
* `DriverLiveLocationStore` holds the high-frequency state in process. It is
  the one class Redis replaces later.

**Assignment protection** is unchanged from Phase 2 and still MongoDB-only:
a driver is reserved with a compare-and-set on `{ isAvailable: true,
currentRideId: null }`, plus partial unique indexes (one active ride per
driver, one per customer).

**Reactive dispatch.** Offers now expire at their deadline (per-ride timers),
and open searches are re-matched as soon as a driver becomes free (goes
online, completes, cancels, rejects). The 5 s sweep remains as a safety net
after restarts.

## Mobile architecture

```
UI ─► Riverpod providers ─► RideRepository (REST) ─┐
                         └► RideUpdatesSource ─────┼─► RealtimeClient (one socket) ─► /realtime
DriverDutyBinding ─► DriverLocationService (GPS) ──┘
```

* `core/realtime/` — `SocketIoRealtimeClient`: connects when a customer or
  approved driver is signed in, reads the token on every reconnect, refreshes
  it through the shared single-flight `TokenRefresher` on
  `AUTH_TOKEN_EXPIRED`/`session.expired`, re-joins remembered rooms.
* `RealtimeRideUpdatesSource` — REST snapshot on listen, pushed snapshots
  after that, **REST re-sync after every `session.ready` and every return to
  the foreground**. Older snapshots (lower `stateVersion`) are dropped.
* `core/location/` — `DriverLocationService` owns permission, the GPS stream,
  filtering (accuracy, age, burst, impossible jumps) and heartbeats;
  `LocationTrackingPolicy` is the only place frequencies live
  (waiting 25 m/10 s, to pickup and on trip 10 m/3–4 s).
* `DriverDutyBinding` (mounted at the app root) sets the tracking mode from the
  server's duty state, so streaming resumes after an app restart and stops on
  offline/logout.
* **Background location.** Android: geolocator's location foreground service
  with an ongoing "You are online" notification (`FOREGROUND_SERVICE_LOCATION`;
  "while in use" permission suffices). iOS: `UIBackgroundModes: location`
  with the background indicator. Subject to OS battery policies.
* **Restart recovery.** Customer and driver shells reopen an in-flight ride
  once on launch; the ride screen joins its room and re-syncs.
* **Maps.** `flutter_map` with a configurable raster tile source
  (`--dart-define=MAP_TILE_URL=… MAP_ATTRIBUTION=…`). The OpenStreetMap default
  is for development only — its tile policy forbids production app traffic.
  Use MapTiler, Mapbox, Stadia or self-hosted tiles for release. The route
  line is straight until a road-routing provider is bound to `RouteEstimator`.

## Run locally

Same as Phase 2; no new infrastructure. New settings are in `.env.example`
under *Realtime* and *Driver location*. The defaults work.

Emulator GPS: Android emulator → *Extended controls → Location* (set a point
or play a GPX route near Vrindavan). iOS simulator → *Features → Location*.

## Two-device test

1. Driver: **Go online** → grant location → the status card shows *Location on*.
2. Customer: book an Auto from *Prem Mandir* to *Banke Bihari Temple* — the
   driver's request appears instantly (no polling).
3. Driver: **Accept** — the customer immediately sees the driver's details and
   the driver on the map.
4. Move the driver (emulator route) — the marker glides and turns; within
   500 m the customer sees *Driver is arriving*.
5. Driver: **I've arrived** → the OTP appears on the customer phone at once.
6. Driver enters the OTP → **Start** → both apps switch to the trip; the
   marker keeps moving toward the destination.
7. Driver: **Complete** → both apps show the completion; the driver is
   available again.

Failure drills: toggle airplane mode on either phone mid-ride (banner shows
*Reconnecting…*, state catches up on reconnect); kill and reopen either app
(the ride screen comes back); deny location (going online explains and links
to settings); stop the driver's GPS for > 60 s (no new offers reach them);
cancel from either side (the other app updates instantly).

## Tests

```bash
cd tirvona/Tirvona_ride
npm test                                        # + event plan, live location store, env rules
npm run test:e2e -- test/phase3.e2e-spec.ts     # 24 cases over real sockets
cd ../../tirvona-ride-app && flutter test       # + realtime source, GPS filter, tracking modes
```

`phase3.e2e-spec.ts` covers socket authentication and token expiry, room
authorization (offered driver, strangers, malformed ids), every lifecycle event
reaching the right app with the right view, live location relay (not echoed,
not leaked), location validation/role/ride checks and rate limiting, the
MongoDB write budget, arriving-exactly-once, OTP rotation push, reconnect
recovery, reactive offer timeout, cancellation reaching an offered driver,
offline-with-active-ride refusal, and stale-location exclusion.

## Deliberately not in Phase 3

Redis (presence, GEO, locks, Socket.IO adapter — so run **one** API instance
for now), road routing / real polylines, push notifications when the app is
killed, payments, ratings, SOS.
