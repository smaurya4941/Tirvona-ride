# Business rules — SOS

Who and when:

- Customer: from `DRIVER_ASSIGNED` through `RIDE_STARTED`.
- Driver: from `DRIVER_ACCEPTED` through `RIDE_STARTED` (a ride that was only
  offered is not theirs yet).
- Both: for `SOS_POST_RIDE_GRACE_MINUTES` after the ride completes or is cancelled.
- Only the ride's participants; anyone else gets 404.

On trigger: the phone's GPS fix if it has one within 6 s, otherwise the
driver's last known position, otherwise the pickup — the source is recorded.
The ride context and the user's emergency contacts are frozen on the
incident. One open incident per person per ride: pressing again adds a
location update. Every admin gets a high-priority notification, and the
admin panel shows a red banner on every page within 10 s.

Lifecycle (admin only, forward-only, compare-and-set):
`TRIGGERED → ACKNOWLEDGED → IN_PROGRESS → RESOLVED`; `CANCELLED` means false
alarm. Steps may be skipped forward. Resolving or cancelling requires a note.
Closed incidents stay closed and are never deleted.

Emergency contacts are **not** messaged automatically in V1. The incident
records `contactsNotification: NOT_SENT`, and both the app (after SOS) and
the admin incident page offer one-tap calling instead.
