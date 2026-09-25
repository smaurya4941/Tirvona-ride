# API — Notifications

All routes are scoped to the caller (customer, driver or admin); the user id
always comes from the access token.

| Method | Path | Notes |
| ------ | ---- | ----- |
| GET | `/notifications?page=1&limit=20&unreadOnly=true` | Newest first → `{ items, page, limit, total, hasMore, unreadCount }` |
| GET | `/notifications/unread-count` | `{ unreadCount }` |
| PATCH | `/notifications/:id/read` | Idempotent; someone else's id → 404 `NOTIFICATION_NOT_FOUND` |
| PATCH | `/notifications/read-all` | `{ updated }` |
| POST | `/notifications/device-token` | `{ token, platform: ANDROID \| IOS, deviceId, appVersion? }` — register or refresh (200) |
| POST | `/notifications/device-token/deactivate` | `{ token }` → `{ deactivated }` (only the caller's own token) |

There is no endpoint that creates a notification: they come from backend events.

Item: `{ id, type, title, message, rideId?, referenceId?, data: { [key]: string }, isRead, readAt?, createdAt }`.

Realtime (user room): `notification.created` → `{ notification, unreadCount }`;
`notification.unread_count` → `{ unreadCount }`.

FCM `data` (all strings): `notificationId`, `type`, `rideId?`, `referenceId?`,
plus type-specific keys (`rideCode`, `sosId`, `complaintId`, …). Android:
channel `tirvona_rides`; HIGH priority for ride offers, driver arriving /
arrived, cancellations and SOS; ride-status pushes share the tag
`ride-<rideId>` so they replace each other in the tray.
