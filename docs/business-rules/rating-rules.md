# Business rules — Ratings

A customer may rate a ride only when **all** of these hold:

1. They are the ride's customer (otherwise 404 — the ride's existence is not revealed).
2. `ride.status = COMPLETED`.
3. The payment was verified (`SUCCESS`, or later `REFUNDED` / `PARTIALLY_REFUNDED`).
4. The ride had a driver.
5. It is within `RATING_WINDOW_DAYS` of completion.
6. No rating exists yet (the unique index settles double submits).

The value is a whole number 1–5; the comment is optional (≤ 500). The rated
driver is always `ride.driverId`. Ratings are immutable. Drivers see only
their average, count and star distribution — never who gave which rating.

Rating is never forced: the app offers it after payment with "Skip", and
later from the ride's details ("Rate driver", or "Your rating ★★★★★").
