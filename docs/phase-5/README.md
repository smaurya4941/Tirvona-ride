# Phase 5 — Ratings, notifications, safety & support

Phase 5 closes the post-ride loop and puts safety inside the active ride:

```
Ride COMPLETED ──► Payment VERIFIED ──► Rating (optional, rate now or later) ──► Ride closed
       │                    │
       └── notifications ───┴──► push (FCM) + in-app notification centre

Active ride ──┬── SOS ─────────► admin alert ─► acknowledge ─► in progress ─► resolve
              ├── Share ride ──► public read-only status link (expires after the ride)
              └── Emergency contacts (captured on the SOS incident)

Any ride ─────── Report an issue ─► complaint ─► admin review ─► resolution shown to the user
```

**NestJS stays the authority.** The app never decides whether a ride can be
rated, which driver is rated, whether SOS is allowed, what a share token is,
or whether a notification exists.

| Part | New in Phase 5 |
| ---- | -------------- |
| API | `ratings/`, `notifications/` (in-app + FCM HTTP v1, device tokens), `safety/` (SOS, emergency contacts, share-ride), `complaints/`, admin SOS & complaints, in-process domain-event bus (`infrastructure/events`) |
| Mobile | Notification centre + bell badge, FCM registration/refresh/sign-out, foreground banner, tap routing; rating screen after payment and on ride details; driver rating card; SOS button (customer + driver) with 112 / contact calling; Share ride; Emergency contacts; Help & support (report, list, status) |
| Admin | Safety & SOS (live list, incident page with map, contacts, timeline, actions), app-wide SOS alert banner, Complaints (filters, workflow, internal notes), Notifications, dashboard Safety & support cards |

Detailed references: [architecture](../architecture/phase-5.md) ·
API: [ratings](../api/ratings.md), [notifications](../api/notifications.md),
[safety](../api/safety.md), [complaints](../api/complaints.md) ·
database: [ratings](../database/ratings.md), [notifications](../database/notifications.md),
[sos-events](../database/sos-events.md), [emergency-contacts](../database/emergency-contacts.md),
[support-tickets](../database/support-tickets.md) ·
rules: [rating](../business-rules/rating-rules.md), [notification](../business-rules/notification-rules.md),
[SOS](../business-rules/sos-rules.md), [share-ride](../business-rules/share-ride-rules.md).

## How notifications are produced

Controllers never build notifications. Ride, payment, auth and admin code
publish **domain events after MongoDB has committed**; `NotificationEventsListener`
turns them into notifications through a pure, unit-tested matrix
(`notification-plan.ts`):

```
RideTransitionService ─► RideEventsService ─┬─► Socket.IO (open apps, unchanged)
                                            └─► DomainEvents "ride.transitioned"
LocationRelayService ──────────────────────────► "ride.driver_arriving"
RidePaymentStateService ───────────────────────► "ride.payment_updated"
AdminService (approve / reject) ───────────────► "driver.reviewed"
AuthService.logout ────────────────────────────► "auth.logged_out"
                                                        │
                           NotificationEventsListener ◄─┘
                                  │
          notifications (MongoDB, the record) ─► socket "notification.created" (badge)
                                  └─► FCM push per active device token
```

WebSocket = live application state for an open app. FCM = delivery when the
app is in the background or closed. Neither replaces the other.

Every notification carries a `dedupeKey` (unique index), so a replayed event
never notifies twice. Push outcome (`SENT / PARTIAL / FAILED / NO_DEVICES /
SKIPPED`) is stored on the record; a dead token (FCM `UNREGISTERED`) is
deactivated automatically.

## Configuration

| Variable | Default | Notes |
| -------- | ------- | ----- |
| `PUBLIC_BASE_URL` | `http://localhost:5100` | **Required (HTTPS) in production** — share-ride links |
| `FIREBASE_SERVICE_ACCOUNT_BASE64` | — | Service-account JSON, base64. Or the three below |
| `FIREBASE_PROJECT_ID` / `FIREBASE_CLIENT_EMAIL` / `FIREBASE_PRIVATE_KEY` | — | All or none. Unset → push off, in-app still works |
| `FCM_TIMEOUT_MS` | 10000 | Hard timeout per FCM / OAuth call |
| `PUSH_ANDROID_CHANNEL_ID` | `tirvona_rides` | Must match `MainActivity.kt` |
| `DEVICE_TOKENS_MAX_PER_USER` | 10 | Oldest extra tokens are retired |
| `RATING_WINDOW_DAYS` | 30 | |
| `EMERGENCY_CONTACTS_MAX` | 5 | |
| `SOS_POST_RIDE_GRACE_MINUTES` | 30 | SOS still allowed shortly after a ride ends |
| `SHARE_RIDE_LINK_BASE_URL` | `<PUBLIC_BASE_URL>/api/v1/shared-rides/view` | Point at a hosted page later if wanted |
| `SHARE_RIDE_MAX_HOURS` / `SHARE_RIDE_GRACE_MINUTES` | 12 / 30 | Link lifetime |

FCM is called over HTTP v1 with a signed service-account assertion (no
`firebase-admin` dependency), mirroring the Razorpay gateway pattern:
`PushGateway` (abstract) → `FcmHttpGateway`; the e2e suite binds a fake.

### Mobile (Flutter)

Firebase is configured from `--dart-define-from-file=env/<name>.json` — no
`google-services.json` or Gradle plugin is needed:

```json
"FIREBASE_API_KEY": "…", "FIREBASE_PROJECT_ID": "…",
"FIREBASE_MESSAGING_SENDER_ID": "…",
"FIREBASE_ANDROID_APP_ID": "1:…:android:…", "FIREBASE_IOS_APP_ID": "1:…:ios:…"
```

Values are in Firebase console → Project settings → Your apps. Without them
the app runs with in-app notifications only. iOS additionally needs the Push
Notifications capability and an APNs key uploaded to Firebase.

Flow: sign-in → permission asked **once** (a "no" is respected) → FCM token
→ `POST /notifications/device-token`; token refresh re-registers; sign-out
calls `POST /notifications/device-token/deactivate` and deletes the local
token (the server also retires the device's tokens on `/auth/logout`).
Foreground pushes show an in-app banner with **View**; taps (tray or banner)
open the ride, rating, complaint or notification centre
(`core/notifications/notification_target.dart`). Android shows ride pushes
as heads-up banners on the high-importance `tirvona_rides` channel.

## The one public web page

Share-ride links must open for people without the app, so the API renders a
minimal, script-free, read-only status page at
`GET /api/v1/shared-rides/view/:token` (auto-refresh every 20 s while live).
It uses the same sanitized view as the JSON endpoint. No other customer or
driver web UI exists.

## Testing

```powershell
npm test                                     # 150 unit tests (notification matrix, rating eligibility, SOS lifecycle, share expiry, FCM JWT…)
npm run test:e2e -- test/phase5.e2e-spec.ts  # 44 e2e cases (in-memory MongoDB, fake Razorpay + fake FCM)
cd ../../tirvona-ride-app; flutter test      # 66 tests incl. tap routing, router access, model parsing
```

The e2e suite covers: multi-device tokens, idempotent re-registration,
token refresh, account switch on one phone, logout deactivation and
re-activation, unregister scoping, lifecycle pushes to both devices with the
right priority/collapse key, pagination/unread/read-all, rating before
payment (409), invalid values (0, 6, 2.5, "5"), a client-sent `driverId`
(400), concurrent double-submit (one 201, one 409), driver average 5 & 4 →
4.5, cancellation notifying only the other party, dead-token cleanup, driver
approval notification, emergency-contact CRUD/primary/limit/ownership, SOS
eligibility, repeat press, admin alert, participant scoping, driver SOS with
server-side location fallback, admin ACK → IN_PROGRESS → RESOLVED with
timestamps and forward-only transitions, share-link sanitization (no phones,
ids, customer), revoke, grace-period expiry (410), and the full complaint
workflow including internal notes staying internal.

## Physical-device checklist (roadmap sign-off)

1. Put the Firebase service account in `.env.local` and the app's Firebase
   values in `env/local.json`; `PUBLIC_BASE_URL=http://<PC-LAN-IP>:5100`.
2. Two phones: customer (A) and driver (B). Sign in on both → allow
   notifications → check `device_tokens` has two active rows.
3. Lock phone A. B goes online, A books (unlock just to book), B accepts →
   A gets **Driver on the way**; B arrives → **Your driver has arrived**
   (heads-up); B completes → A **Ride completed**, B **Ride completed**.
4. A pays → A **Payment successful** (tap → rating screen), B **Payment
   received**. Rate 5★ → B's Profile shows the new average.
5. During another ride: A taps **Share ride** → WhatsApp the link → open it in
   a private browser window: status, driver first name, plate; no phone
   numbers. After completion + 30 min the link shows *expired*.
6. A presses **SOS** → confirm → admin panel shows the red banner within
   10 s → open incident → Acknowledge → In progress → Resolve (note). A gets
   the status notifications.
7. Sign out on A → trigger an event for A → no push arrives on that phone.

## Not in Phase 5 (by design)

Driver → customer ratings; automatic SMS/WhatsApp/voice to emergency
contacts (contacts are frozen on the incident for the safety team to call —
the record says `NOT_SENT`, never pretends); chat on complaints; admin
push/browser notifications beyond the in-panel banner and optional desktop
alert; a Redis-backed event bus (the in-process bus has the same interface).
