# API — Safety

## Emergency contacts (customer, driver)

| Method | Path | Body |
| ------ | ---- | ---- |
| GET | `/users/me/emergency-contacts` | → primary first |
| POST | `/users/me/emergency-contacts` | `{ name, phone, relationship?, isPrimary? }` |
| PATCH | `/users/me/emergency-contacts/:id` | any of `{ name, phone, relationship, isPrimary: true }` |
| DELETE | `/users/me/emergency-contacts/:id` | deleting the primary promotes the oldest remaining contact |

Phones are stored as E.164; a 10-digit Indian mobile is accepted and normalised.
Errors: `409 EMERGENCY_CONTACT_LIMIT`, `409 EMERGENCY_CONTACT_DUPLICATE`,
`400 EMERGENCY_CONTACT_SELF`, `404 EMERGENCY_CONTACT_NOT_FOUND`.

## SOS

| Method | Path | Role | Notes |
| ------ | ---- | ---- | ----- |
| POST | `/rides/:id/sos` | customer, driver | `{ latitude?, longitude?, accuracyMeters?, address?, message? }` → `{ sos, created }` |
| GET | `/rides/:id/sos` | customer, driver | The caller's alerts on the ride |
| GET | `/admin/sos?status=&open=true&page=` | admin | Open alerts oldest first |
| GET | `/admin/sos/summary` | admin | `{ open, unacknowledged, acknowledged, inProgress, resolvedToday, oldestUnacknowledgedAt? }` |
| GET | `/admin/sos/:id` | admin | Incident + ride, people, contacts snapshot, timeline, live driver position |
| PATCH | `/admin/sos/:id` | admin | `{ status: ACKNOWLEDGED \| IN_PROGRESS \| RESOLVED \| CANCELLED, note? }` (note required to resolve or cancel) |

`created: false` means an open alert already existed and was updated with the
new position. Errors: `404 RIDE_NOT_FOUND` (not a participant),
`409 SOS_NOT_ALLOWED`, `409 SOS_INVALID_TRANSITION`, `400` when only one of
latitude / longitude is sent.

## Share ride

| Method | Path | Role | Notes |
| ------ | ---- | ---- | ----- |
| POST | `/rides/:id/share` | customer | Active rides only → `{ url, token, expiresAt, shareText }` |
| GET | `/rides/:id/share` | customer | `{ active }` live links |
| DELETE | `/rides/:id/share` | customer | Revokes every link → `{ revoked }` |
| GET | `/shared-rides/:token` | **public** | Sanitized JSON (`SharedRideView`) |
| GET | `/shared-rides/view/:token` | **public** | Read-only HTML page |

Public responses send `Cache-Control: no-store`, `X-Robots-Tag: noindex` and
`Referrer-Policy: no-referrer`; tokens are masked in access logs.
Errors: `404 SHARE_LINK_NOT_FOUND`, `410 SHARE_LINK_EXPIRED`, `409 SHARE_NOT_ALLOWED`.
