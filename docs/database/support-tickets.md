# Collection — `support_tickets`

| Field | Notes |
| ----- | ----- |
| `ticketCode` | `TKT-XXXXXX`, unique |
| `userId`, `userRole` | Who reported it (customer or driver) |
| `rideId?`, `rideCode?`, `customerId?`, `driverId?` | Ride snapshot |
| `category` | See the complaints API |
| `subject`, `description` | ≤ 120 / ≤ 2000 chars |
| `status` | `OPEN → IN_REVIEW → RESOLVED → CLOSED` (RESOLVED may reopen to IN_REVIEW) |
| `priority` | `LOW \| MEDIUM \| HIGH \| URGENT` (SAFETY starts URGENT) |
| `assignedAdminId?` | |
| `resolution?` | Shown to the user |
| `resolvedAt?`, `closedAt?` | |
| `history[]` | `{ at, byUserId, byRole, action: CREATED \| STATUS \| NOTE \| ASSIGNED \| PRIORITY_*, status?, note? }` — notes are admin-only |

Indexes: `{ticketCode}` unique, `{userId, createdAt:-1}`, `{rideId, createdAt:-1}`,
`{status, priority, createdAt:-1}`, `{createdAt:-1}`.
