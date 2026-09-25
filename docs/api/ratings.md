# API — Ratings

Base `/api/v1`. V1 is customer → driver only.

| Method | Path | Role | Body / result |
| ------ | ---- | ---- | ------------- |
| POST | `/rides/:id/rating` | customer | `{ rating: 1..5 (integer), comment?: ≤500 chars }` → `RatingView` (201) |
| GET | `/rides/:id/rating` | customer | `{ rideId, canRate, reason?, windowEndsAt?, rating: RatingView \| null, driver: { name, ratingAverage, ratingCount, vehicle? } }` |
| GET | `/drivers/me/ratings` | driver | `{ ratingAverage, ratingCount, totalRides, distribution: { "1".."5": n } }` |

`driverId` is never accepted (unknown fields → 400); the driver always comes
from the ride. `GET /drivers/me`, ride views and the driver dashboard also
carry `ratingAverage` and `ratingCount`.

Errors: `404 RIDE_NOT_FOUND` (not your ride), `409 RATING_NOT_ALLOWED` (not
completed / not paid), `409 RATING_ALREADY_EXISTS`, `409 RATING_WINDOW_CLOSED`,
`400` validation.

`reason` values: `RIDE_NOT_COMPLETED`, `PAYMENT_NOT_VERIFIED`, `NO_DRIVER`, `WINDOW_CLOSED`.
