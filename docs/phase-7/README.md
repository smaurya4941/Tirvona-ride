# Phase 7 — Admin Panel Completion & Hardening

Phase 6 was skipped on purpose; nothing here depends on it.

**Done condition.** A non-developer admin can run Tirvona Rides V1 from the admin panel, with no MongoDB edits, while the API enforces authorization, validation, rate limits and business rules. Ride state machine, pricing, matching, cancellation and promo logic have automated tests.

| Codebase | What changed |
| --- | --- |
| API (`tirvona/Tirvona_ride`) | New modules: `audit`, `zones`, `promotions`, `cancellations`, `reports`, plus broadcasts inside `notifications`. Ride types are now data. Admin login is its own endpoint. Blocking takes effect at once. Per-route rate limits. New admin APIs for customers, vehicles, driver suspension and the audit log. |
| Admin panel (`tirvona/Tirvona_ride_admin`) | Grouped navigation and a rebuilt dashboard. New pages: Customers, Vehicles, Ride types, Zones, Promo codes, Cancellations (records, reasons, fee policy), Broadcasts, Reports (7 tabs) and Audit log. Drivers now have search and paging, plus suspend and reinstate. Every high-impact action asks for confirmation. |
| Flutter app (`tirvona-ride-app`) | Promo codes at booking and cancellation with server-provided reasons and fees, for both customers and drivers. Ride types come from the server, E-Rickshaw is added, and announcement deep links work. The app refreshes the session as soon as a driver is suspended or reinstated. |

---

## 1. Authorization

The global guards are `JwtAuthGuard` followed by `RolesGuard`. Every route is authenticated unless it carries `@Public()`.

- **Phase 7 addition: account status.** `JwtAuthGuard` now also checks the account's status through `AccountStatusService`, cached for 15 s. Blocking a customer makes their next request fail with `403 USER_BLOCKED`, and every refresh session is revoked.
- **Admin sign-in.** `POST /admin/auth/login` accepts ADMIN accounts only. Any other account gets the generic `AUTH_INVALID_CREDENTIALS` error, so the endpoint does not reveal which accounts are admins. It carries the strictest rate limit.
- **Test enforcement.** `test/phase7.e2e-spec.ts › Authorization audit` reads route metadata from the running app and fails the build if:
  - any `/admin/**` route (other than admin sign-in) is not `@Roles(ADMIN)`;
  - the set of `@Public()` routes changes from the allow-list (auth, admin sign-in, payment webhook, health, share-ride page);
  - driver ride actions stop being DRIVER-only, or booking stops being CUSTOMER-only.

### Permission matrix (source of truth)

| Endpoint group | Customer | Driver | Admin |
| --- | --- | --- | --- |
| Auth (`/auth/*`) | own | own | `/admin/auth/login` |
| Profile, saved places, emergency contacts | own | own | view (customer detail) |
| Driver profile, KYC, vehicle, availability | ❌ | own; `APPROVED` required to go online or take rides | ✅ approve / reject / suspend / reinstate |
| Rides | book; own rides only | assigned rides only; must be `APPROVED` | all; cancel with reason |
| Cancellation preview and cancel | own, customer reasons | assigned, driver reasons | admin reasons, never a fee |
| Payments | own | own earnings | all |
| Ratings | own | own ratings | view |
| Notifications | own | own | inbox + broadcasts |
| Promotions | `GET /promotions`, `POST /promotions/check`, `POST /promotions/validate` | ❌ | manage |
| Ride types, pricing, zones | read bookable types | ❌ | manage |
| Reports, audit log | ❌ | ❌ | ✅ |
| SOS | create own | create own | manage |

Ownership is part of each query (for example `{ _id, customerId }` or `{ _id, driverId }`). Anything outside it returns 404, so a caller cannot probe for rides that exist but belong to someone else. The e2e suite covers customer A → customer B's ride, driver B → driver A's ride, and a driver acting on a ride that was never offered to them.

## 2. Validation

- `ValidationPipe({ whitelist, forbidNonWhitelisted, transform })` is global, so unexpected fields get a 400.
- Every new endpoint has a DTO with:
  - lengths, enums and numeric ranges;
  - money limited to 2 decimals;
  - coordinates, dates, and a code pattern for ride types, promos and reasons;
  - pagination capped at 100 per page.
- Route ids go through `ParseObjectIdPipe`. The admin driver routes did not validate ids before this phase.
- Auth DTOs gained length limits on password, device fields and refresh token.

## 3. Rate limiting

Limits are per client IP and per route. Each route has its own budget, so exhausting OTP sends never blocks login.

| Policy | Routes | Default | Env |
| --- | --- | --- | --- |
| `auth` | register, login | 10 / min | `THROTTLE_AUTH_*` |
| `otpSend` | `/auth/send-otp` | 3 / 10 min | `THROTTLE_OTP_SEND_*` |
| `otpVerify` | `/auth/verify-otp` | 10 / 10 min | `THROTTLE_OTP_VERIFY_*` |
| `refresh` | refresh, logout | 30 / min | `THROTTLE_REFRESH_*` |
| `adminLogin` | `/admin/auth/login` | 5 / 5 min | `THROTTLE_ADMIN_LOGIN_*` |
| `promo` | `/promotions/check`, `/promotions/validate` | 20 / min | `THROTTLE_PROMO_*` |
| default | everything else | `THROTTLE_LIMIT` / `THROTTLE_TTL_MS` | |

- WebSockets are not affected: `HttpThrottlerGuard` skips non-HTTP contexts, and the payment webhook is `@SkipThrottle`.
- There is no password-recovery endpoint in V1, so none is throttled.
- Older e2e suites raise these limits in their environment. `phase7.e2e-spec.ts` tests the real behaviour with OTP send = 2 and admin login = 3.

## 4. Ride types

- Codes are data (`^[A-Z][A-Z0-9_]{1,23}$`), so admins can create products such as `CAB_XL` served by CAB drivers.
- **E-Rickshaw.**
  - `E_RICKSHAW` is seeded **inactive with no tariff**: its prices are a business decision.
  - Activating any ride type is refused until it has a tariff (`RIDE_TYPE_PRICING_REQUIRED`).
  - `VehicleType.E_RICKSHAW` is new, so drivers can register e-rickshaws in the app.
- **No delete.** Ride types are switched off instead, and switching one off requires a reason, which goes to the audit log. Past rides keep their ride type code, vehicle type and fare snapshot.
- **Pricing (audited, not rebuilt).**
  - `PATCH /admin/pricing/:code` creates the first tariff when all four rates are sent. Every change bumps the version.
  - Booked rides keep their snapshot, so old rides are never re-priced.

## 5. Zones

- A zone is a GeoJSON polygon with a 2dsphere index. Admins give the boundary as ordered points; the admin editor can also generate a circle around a centre point.
- The server closes the ring and rejects outlines with fewer than 3 points, zero area, or edges that cross (`ZONE_INVALID_BOUNDARY`). Zone names are unique regardless of letter case.
- **Service availability rule.**
  - With **no active zone**, pickups are allowed anywhere (the pre-Phase 7 behaviour, so nothing breaks until an admin creates a zone).
  - Once **any zone is active**, estimates and bookings with a pickup outside every active zone get `400 SERVICE_AREA_UNAVAILABLE`.
- Each ride stores its pickup zone (`zoneId`, `zoneName`) for reports. **Zone-based pricing is deliberately not implemented.**

## 6. Promo codes

- **Fields:**
  - code, title, description;
  - `FLAT` or `PERCENTAGE` discount, with an optional max discount;
  - minimum fare, total usage limit, per-customer limit;
  - start and end dates, status;
  - eligible ride types (empty means all);
  - `showInApp` to list the code in the app's offers.
- **The server always decides.** `evaluatePromo` checks, in this order:
  1. active
  2. started
  3. not expired
  4. ride type allowed
  5. minimum fare met
  6. total usage limit not reached
  7. per-customer limit not reached
- **Saving a code before a trip (Offers tab).** `POST /promotions/check {code}` runs the checks that need no trip (`precheckPromo`: active, started, not expired, total and per-customer limits) and returns the offer. It works for codes that are not `showInApp` too. The app keeps the code as `BookingState.savedPromo` and, on "Choose a ride", applies it through `/promotions/validate` for the selected ride type. A refusal for ride type or minimum fare keeps the code saved, with the reason shown, so it can apply to another ride type. Any other refusal drops it. Nothing is reserved until booking. Same `promo` throttle as validate.
- **Booking reserves a use.** It creates a `RESERVED` redemption and increments `usedCount` in one conditional update (`usedCount < usageLimit`), so the limit holds under concurrent bookings. The per-customer limit cannot race either, because the database allows one active ride per customer.
- **Ride outcomes, handled by the `ride.transitioned` listener:**
  - completed → `REDEEMED`, with the discount recomputed on the final fare using the rules frozen on the ride;
  - cancelled or no driver found → `RELEASED`, and the use is given back.
- **Money flow:**
  - The platform funds the discount. `fare.payableFare = finalFare − discount`, and payment collects `payableFare`.
  - The driver's earning line is computed on the **full fare**, and `promoDiscountPaise` is recorded on it.
  - A customer always pays at least ₹1, so every ride still produces a payment and an earning.
  - On cash rides the driver collected fare − discount, so the discount is netted against the driver's `commissionDue`. A negative `commissionDue` means Tirvona owes the driver.

## 7. Cancellations

**Reasons.**
- There is a separate reason list for customers, drivers and admins, seeded from the Phase 7 plan's examples.
- Admins can relabel, reorder, add or retire reasons; codes never change. `OTHER` requires a note and cannot be retired.
- Older app builds that send only free text are recorded under `OTHER`.

**Records.**
- Every cancel writes a `cancellations` row with: ride, actor, reason code and label, note, ride status at cancellation, booked fare, fee, fee status, policy version and time.
- The ride keeps a copy of the reason, fee and fee status for the apps to show.

**Fee policy.**
- The policy is versioned and edited only by admins. **The seeded version 1 charges nothing.**
- Configurable values:
  - enabled or not;
  - free window after the driver accepts;
  - flat part plus a percentage of the booked fare;
  - cap;
  - which statuses it applies to (driver accepted and/or arrived).
- Rules that are not configurable:
  - only customers can be charged;
  - no fee before a driver has accepted;
  - never more than the fare;
  - admin cancellations are never charged, and driver cancellations carry no penalty.

**Flow (`RideLifecycleService.cancel`).** The server:
1. identifies the actor;
2. checks the ride is in a cancellable state;
3. validates the reason;
4. assesses the fee against the status the ride is leaving;
5. moves the ride to CANCELLED (compare-and-set, carrying the fee);
6. writes the record;
7. releases the driver.

Notifications and promo release follow from the ride event.

**Collecting fees.** An assessed fee is stored as `DUE`, and admins mark it `WAIVED` or `COLLECTED` on the Cancellations page. **Automatic collection is not built** (see §12).

**State machine.** Invalid moves are rejected with 409, for example completed → cancel, cancel twice, cancel after the trip has started, start after completion, or complete a cancelled ride. These are covered exhaustively in `ride-state-machine.spec.ts` and end to end in the e2e suite.

## 8. Broadcasts (admin → users)

These are separate from system notifications, which continue to come only from domain events.

- **Audiences:** all customers, all drivers, approved drivers, or everyone. Blocked accounts are always excluded.
- **Deep links:** an allow-list of NONE, HOME, RIDES, OFFERS, NOTIFICATIONS, SUPPORT. The app maps them itself, so a broadcast can never inject a URL.
- **Lifecycle:** DRAFT → (SCHEDULED) → SENDING → SENT, or CANCELLED / FAILED.
- **Sending:**
  - Each recipient gets one `ANNOUNCEMENT` notification, in-app plus push.
  - Each user is notified at most once per broadcast (`broadcast:<id>:<user>`).
  - Sends run in batches in user-id order with a lease, so an interrupted send resumes where it stopped.
  - A worker picks up due scheduled broadcasts and stalled sends (`BROADCAST_WORKER_INTERVAL_MS`, 0 disables it).

## 9. Reports and analytics

`GET /admin/reports/{overview|rides|revenue|drivers|customers|cancellations|promotions}` accepts `preset=TODAY|YESTERDAY|LAST_7_DAYS|LAST_30_DAYS`, or `from` and `to` local dates (both inclusive). Days are counted in `APP_TIME_ZONE`, and a range can cover at most `REPORT_MAX_RANGE_DAYS` days.

Every figure is aggregated from the underlying records, so reports reconcile with the data by construction. The e2e suite checks this against the raw collections.

| Figure | Definition |
| --- | --- |
| Rides report | the rides **requested** in the range, counted by final outcome; completion and cancellation rates use requested as the denominator |
| Completed ride value | Σ `fare.finalFare` of rides **completed** in the range |
| Gross booked value | Σ `fare.estimatedFare` of rides requested in the range |
| Promo discounts | Σ `fare.discount` of rides completed in the range |
| Collected (online / cash) | Σ settled payments by `paidAt` |
| Driver earnings, commission | Σ earning lines by `rideCompletedAt` |
| Net platform revenue | commission − promo discounts |
| Cancellation fees | cancellation records by `cancelledAt`, split into due, collected and waived |
| No driver found | reported separately as the system outcome; it is not a cancel action |

Customer reports contain aggregates only, with no personal data. The admin dashboard (`GET /admin/dashboard`) takes the same `preset` or `from`/`to` (default TODAY): its KPIs and trend follow the selected period (a one-day period shows the last 7 days as trend), while live operations are always "right now".

## 10. Audit trail

Admin actions are written to `admin_audit_logs` (append-only). Each entry records the admin, action, target, reason and details. The admin panel shows the log under **Analytics → Audit log**; driver, customer and ride pages link to their own entries.

Covered actions:
- driver approve, reject, suspend, reinstate;
- customer block and unblock;
- ride cancel;
- pricing, ride type and zone changes;
- promo create, update, activate, deactivate;
- cancellation reason and policy changes, fee waive or collect;
- broadcast schedule, send and cancel.

## 11. Indexes added

| Collection | Indexes |
| --- | --- |
| users | `{role, createdAt}` |
| driver_profiles | `{driverStatus, createdAt}` |
| rides | `{requestedAt}`, `{status, completedAt}`, `{status, cancelledAt}`, `{zoneId, requestedAt}` (partial), `{promo.promoId}` (partial) |
| payments | `{paidAt, status}` |
| driver_earnings | `{rideCompletedAt}` |
| zones | unique `nameKey`, `{status, name}`, 2dsphere `boundary` |
| promo_codes | unique `code`, `{status, endsAt}` |
| promo_redemptions | unique `rideId`, `{promoId, userId, status}` |
| cancellations | unique `rideId`, `cancelledAt`, actor, reason and fee-status indexes |
| broadcasts | `{status, scheduledAt}`, `{status, leaseUntil}` |
| admin_audit_logs | `createdAt`, target, admin, action |

## 12. Business decisions still to lock

1. **Cancellation fee values.** The mechanism is built but the seeded policy is off. Set the values on **Cancellations → Fee policy** once approved.
2. **Collecting cancellation fees.** V1 records fees as `DUE`, and admins resolve them manually. Options for later: add the fee to the customer's next ride payment, or take it through Razorpay.
3. **E-Rickshaw tariff.** Required before activation.
4. **Promo accounting.** Discounts are platform-funded; this can be changed if Tirvona decides otherwise.
5. **Driver cancellation penalties.** None exist: driver cancellations are recorded and reported only.

## 13. Known limitations

- A blocked customer's already-open socket stays connected until it reconnects. REST calls are refused immediately, and the socket handshake refuses blocked accounts.
- `AccountStatusService` caches for 15 s per instance, so other API instances pick up a block within 15 s.
- The zone editor has no map, only a list of points, an outline preview and a circle generator. A map-based editor would need a map library in the admin panel.

## 14. Tests

| Suite | Coverage |
| --- | --- |
| Unit (`npx jest`, 324 tests) | state machine (exhaustive transition table and refusals); pricing (determinism, edge cases, each ride type); promo rules; cancellation fee; zone geometry; report date ranges |
| `test/phase7.e2e-spec.ts` (55 tests) | authorization audit and permission matrix; ownership; validation; rate limits; ride types; zones; promo lifecycle and money; cancellations and fees; admin customer/driver actions; broadcasts; reports reconciliation; matching rules (eligible, offline, busy, unapproved, suspended, wrong vehicle, stale location, out of radius, exclusions, single reservation) |
| Earlier suites | phases 1–5 and places are green. They were updated for paginated `/admin/drivers`, E-Rickshaw, the OTHER reason and the stricter throttles; Phase 1's OTP log regex was also fixed |
| Flutter (`flutter test`, 114 tests) | `test/features/phase7/phase7_test.dart` covers models, deep links, the cancel sheet (reasons, fee, note) and promos in booking |

Run the API end-to-end suites with `npm run test:e2e -- test/phase7.e2e-spec.ts`. They use mongodb-memory-server.

## 15. Operational scenarios (all runnable from the panel)

1. **Driver onboarding.** The driver registers and their KYC goes under review. The admin approves it on **Drivers & KYC**, and the driver goes online.
2. **Ride.** The customer books, the driver is matched and accepts, arrives and starts the trip with the OTP, then completes it. The customer pays and rates the ride.
3. **Cancellation.** The customer cancels and picks a reason. The fee comes from the policy, the record is written, and both sides are notified. The admin can waive the fee on **Cancellations**.
4. **Promotion.** The admin creates a code on **Promo codes**. The customer applies it on the confirm screen, the server validates and reserves it, the ride completes with the discount, and the use is recorded.
5. **Broadcast.** The admin writes the message on **Broadcasts**, picks an audience, and confirms. Delivery goes out by FCM plus in-app, and the history records it.
