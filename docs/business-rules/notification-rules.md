# Business rules — Notifications

| Event | Customer | Driver | Admin |
| ----- | -------- | ------ | ----- |
| Booking / re-matching (SEARCHING) | — | — | — |
| Driver assigned | Driver found | **New ride request** (high) | — |
| Driver accepted | Driver on the way | — | — |
| Driver arriving (once per ride) | Driver arriving (high) | — | — |
| Driver arrived | Your driver has arrived (high) | — | — |
| Ride started | Ride started | Trip started | — |
| Ride completed | Ride completed — tap to pay | Ride completed | — |
| Payment success | Payment successful — tap to rate | Payment received | — |
| Payment failed | Payment failed — try again | — | — |
| Ride cancelled | unless they cancelled it | unless they cancelled it | — |
| No driver found | No drivers available | — | — |
| Driver approved / rejected | — | ✓ | — |
| SOS raised | confirmation to whoever pressed it | same | **every admin** (high) |
| SOS status changed | to whoever pressed it | same | — |
| Complaint created / updated | confirmation / new status + resolution | same, for drivers' own tickets | new complaint → every admin |

- Whoever caused a change is not notified of it.
- The other party of an SOS is deliberately **not** told that an alert was
  raised: telling a threatening person could escalate the danger.
- Every notification is stored in-app first; push is best effort per device.
- Types are a closed server enum; no client can create a notification.
- Push permission is asked once after sign-in; a refusal is respected.
- Sign-out deactivates the device's token (the app's call plus server-side on
  `/auth/logout`) and deletes it locally.
