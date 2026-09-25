# Collections — `notifications`, `device_tokens`

## notifications

| Field | Notes |
| ----- | ----- |
| `userId`, `recipientRole` | Recipient |
| `type` | Closed enum (`NotificationType`) |
| `title`, `message` | ≤ 120 / ≤ 500 chars |
| `rideId?`, `referenceId?` | What it is about (SOS id, complaint id, …) |
| `data` | Flat string map — also the FCM `data` payload |
| `isRead`, `readAt` | |
| `dedupeKey?` | Unique (partial index): replayed events are dropped |
| `push` | `{ status: PENDING \| SENT \| PARTIAL \| FAILED \| NO_DEVICES \| SKIPPED, sentCount, failedCount, attemptedAt, error }` |

Indexes: `{userId, createdAt:-1}`, `{userId, isRead, createdAt:-1}`,
`{dedupeKey}` unique partial, TTL on `{createdAt}` (180 days).

## device_tokens

| Field | Notes |
| ----- | ----- |
| `userId` | Current owner (a token moves when another account signs in on that phone) |
| `token` | Unique |
| `platform` | `ANDROID` \| `IOS` |
| `deviceId` | App install id (the same one sent at login) |
| `isActive`, `deactivatedAt`, `deactivationReason` | `LOGOUT` \| `REPLACED` (token refresh) \| `UNREGISTERED` (FCM said so) \| `LIMIT` |
| `lastUsedAt` | Last registration or successful push |

Indexes: `{token}` unique, `{userId, isActive, lastUsedAt:-1}`, `{userId, deviceId}`.
Tokens are deactivated, never deleted.
