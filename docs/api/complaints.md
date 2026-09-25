# API — Complaints / support

| Method | Path | Role | Notes |
| ------ | ---- | ---- | ----- |
| POST | `/complaints` | customer, driver | `{ rideId?, category, subject, description (≥10 chars) }` |
| GET | `/complaints?status=&page=` | customer, driver | Own tickets |
| GET | `/complaints/:id` | customer, driver | Own ticket: status, resolution, status timeline (no internal notes, no priority) |
| GET | `/admin/complaints?status&category&priority&search&page` | admin | `search`: ticket code, ride code, phone, first name |
| GET | `/admin/complaints/summary` | admin | `{ open, inReview, urgentOpen, resolvedToday }` |
| GET | `/admin/complaints/:id` | admin | + user, customer, driver, ride, full history |
| PATCH | `/admin/complaints/:id` | admin | `{ status?, priority?, resolution?, note?, assignToMe? }` |

Categories: `DRIVER_BEHAVIOUR` (customers only), `CUSTOMER_BEHAVIOUR`
(drivers only), `PAYMENT`, `FARE`, `RIDE_ISSUE`, `SAFETY`, `LOST_ITEM`,
`TECHNICAL`, `OTHER`. Ride-specific categories require `rideId`, a ride the
caller took part in.

Errors: `400 COMPLAINT_NOT_ALLOWED`, `409 COMPLAINT_ALREADY_OPEN` (`data.id` is
the open ticket), `409 COMPLAINT_INVALID_TRANSITION`, `404 COMPLAINT_NOT_FOUND`.
