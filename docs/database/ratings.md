# Collection — `ratings`

| Field | Type | Notes |
| ----- | ---- | ----- |
| `rideId` | ObjectId | unique |
| `customerId` | ObjectId (User) | from the ride |
| `driverId` | ObjectId (DriverProfile) | from the ride, never from the request |
| `driverUserId` | ObjectId (User) | |
| `rating` | int 1–5 | immutable |
| `comment` | string ≤ 500 | optional, immutable |
| `createdAt` / `updatedAt` | Date | |

Indexes: `{rideId}` unique, `{rideId, customerId}` unique,
`{driverId, createdAt:-1}`, `{customerId, createdAt:-1}`.

Driver aggregate on `driver_profiles`: `ratingSum`, `ratingCount` and
`ratingAverage` (2 dp), updated in **one pipeline update** per rating so
concurrent ratings never lose each other's stars.
`RatingsService.rebuildDriverAggregate` recomputes them from this collection
if the incremental update ever fails.
