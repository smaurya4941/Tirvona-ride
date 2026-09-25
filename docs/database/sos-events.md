# Collections — `sos_events`, `ride_share_tokens`

## sos_events (never deleted)

| Field | Notes |
| ----- | ----- |
| `sosCode` | `SOS-XXXXXX`, unique, read out on calls |
| `rideId`, `rideCode`, `rideStatus` | The ride at trigger time |
| `userId`, `userRole` | Who pressed SOS |
| `customerId`, `driverId`, `driverUserId` | Ride participants |
| `status`, `isOpen` | `TRIGGERED → ACKNOWLEDGED → IN_PROGRESS → RESOLVED`, or `CANCELLED` (false alarm) |
| `location` | `{ latitude, longitude, accuracyMeters?, address?, source: DEVICE \| DRIVER_LAST_KNOWN \| RIDE_PICKUP, capturedAt }` |
| `locationUpdates[]` | Later presses while open (last 50) |
| `message?` | From the user |
| `emergencyContacts[]` | Snapshot at trigger time |
| `contactsNotification` | `NOT_SENT` — no SMS / WhatsApp integration yet; never claims delivery |
| `triggeredAt`, `acknowledgedAt`, `inProgressAt`, `resolvedAt`, `cancelledAt` | |
| `adminId`, `resolutionNote` | |
| `timeline[]` | `{ status, at, byUserId, byRole, note }` |

Indexes: `{sosCode}` unique, `{rideId, createdAt:-1}`, `{userId, createdAt:-1}`,
`{status, createdAt:-1}`, `{createdAt:-1}`, and `{rideId, userId}` unique
where `isOpen` (one open alert per person per ride).

## ride_share_tokens

`rideId`, `customerId`, `tokenHash` (SHA-256 — the token itself is never
stored), `expiresAt`, `isActive`, `revokedAt?`, `viewCount`, `lastViewedAt`.

Indexes: `{tokenHash}` unique, `{rideId, isActive}`, TTL on `expiresAt`
(purged 7 days after it stops working).
