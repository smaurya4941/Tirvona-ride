# Collection — `emergency_contacts`

| Field | Notes |
| ----- | ----- |
| `userId` | Owner (customer or driver) |
| `name` | ≤ 80 chars, required |
| `phone` | E.164, required |
| `relationship?` | ≤ 40 chars |
| `isPrimary` | Exactly one per user while the user has contacts |

Indexes: `{userId, createdAt}`, `{userId, phone}` unique, and `{userId}`
unique where `isPrimary: true`.

A separate collection (rather than an array on `users`) keeps CRUD simple and
lets an SOS incident take a snapshot of the contacts.
