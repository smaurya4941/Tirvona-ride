# Architecture — Phase 5

```
Flutter (customer + driver) ── REST ──► NestJS (business authority) ──► MongoDB (records)
        ▲      ▲                             │  domain events (in-process)
        │      └──── Socket.IO (live state) ─┤
        └─────────── FCM (push) ◄────────────┘  NotificationsService → FcmHttpGateway
Admin web (React) ── REST (SOS polled every 10 s) ──► NestJS
Public share link ── GET /api/v1/shared-rides/view/:token (read-only HTML)
```

## Modules and dependency direction (no cycles)

| Module | Depends on | Notes |
| ------ | ---------- | ----- |
| `infrastructure/events` (global) | — | `DomainEventsService`: typed `emit`/`on`, handlers run on the next tick, errors logged, `drain()` for tests |
| `notifications` | Realtime, Users (model), Rides (schema) | Listener, notification matrix, device tokens, FCM gateway, REST |
| `ratings` | Rides / Drivers / Users (schemas only) | Driver aggregate lives on `driver_profiles` |
| `safety` | Notifications, Locations, Users | SOS, emergency contacts, share-ride (+ public controller) |
| `complaints` | Notifications, Users, Rides / Drivers (schemas) | Support tickets |
| `admin` | Safety, Complaints (+ Phases 1–4) | `/admin/sos`, `/admin/complaints`, dashboard cards |

Rides, Payments and Auth **never import** Notifications or Safety. They
publish `ride.transitioned`, `ride.driver_arriving`, `ride.payment_updated`,
`driver.reviewed` and `auth.logged_out`. This keeps the Phase 3 rule — one
write point per state, one place events originate — and lets a Redis/queue
bus replace the in-process one without touching producers or consumers.

## Delivery guarantees

- The in-app notification is written first (the record); push is attempted
  afterwards, per device, and its outcome is stored on the record.
- Producers never wait for, or fail because of, consumers.
- `dedupeKey` (unique index) makes consumers idempotent under replays.
- Share links: expiry is enforced on every read (ride end + grace) even if
  the "ride ended" handler did not run.

## Mobile structure

```
lib/core/notifications/        push_config, push_notifications (FCM lifecycle), notification_target (tap routing)
lib/features/notifications/    models, repository, state (unread badge), screens (centre), widgets (bell)
lib/features/customer/rating/  models, repository, screens (rate driver), widgets (stars, ride card)
lib/features/driver/ratings/   rating summary + profile card
lib/features/safety/           models, repository, screens (emergency contacts), widgets (SOS, share ride)
lib/features/complaints/       models, repository, screens (support list, report form, detail)
```

Notifications, safety and complaints are shared by both roles: one
implementation, routed under `/customer/...` or `/driver/...`.
