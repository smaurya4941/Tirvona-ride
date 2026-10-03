# Peak-hour pricing

Tests: `src/modules/pricing/peak-pricing.spec.ts` (rules and boundaries), `test/peak-pricing.e2e-spec.ts` (admin API, resolver, estimate, booking, frozen price), Flutter `test/features/rides/peak_pricing_test.dart`.

## Rules
- **Base pricing is untouched.** A ride type's tariff (base fare, per km, per minute, minimum fare) stays the permanent price list.
- **A peak is an adjustment.** A slot has a daily time window, a hike percentage, and the ride types it applies to (all, or a chosen few).
- **Only per-km moves.** Effective per-km = base per-km × (1 + hike%), rounded to the paisa (₹18 + 50% = ₹27). Base fare, per-minute and minimum fare are unchanged, and the minimum fare still applies after the hike.
- **The server decides.** The slot in force is found from the API's clock in the business time zone (`APP_TIME_ZONE`, default Asia/Kolkata). The apps never calculate a peak and never send a time.
- **Start inclusive, end exclusive.** 4:00 PM – 8:00 PM prices 4:00:00 PM to 7:59:59 PM at peak and 8:00 PM at normal rates.
- **Midnight works.** An end earlier than the start (10:00 PM → 2:00 AM) wraps past midnight. Equal start and end is rejected.
- **No overlaps.** Two *active* slots cannot cover the same minute for the same ride type (an "all" slot overlaps everything). Back-to-back slots are fine. Disabled slots are ignored, and re-enabling one is checked again.
- **Rides keep their price.** At booking the API re-prices from scratch (an old estimate is never trusted) and copies the applied peak onto the ride. The ride keeps that per-km rate through completion, including actual-trip final pricing, whatever happens to the slot afterwards.

## Data
`peak_pricing_slots`: `name` (unique, case-insensitive), `startTime`/`endTime` (`HH:mm`), `hikePercent` (0.01–300, two decimals), `appliesToAll`, `rideTypes[]`, `isActive`, `version`, `createdBy`/`updatedBy`, timestamps.

`rides.fare` gains `basePerKmRate` and `peak { slotId, name, hikePercent, startTime, endTime, surcharge }`. `fare.perKmRate` is the rate the ride is charged at (the peak rate when `peak` is set). Rides booked before this feature have neither field and read as normal pricing.

## Admin API (`/admin/peak-pricing`, admin only)
| Route | |
|---|---|
| `GET /` | every slot with `isLive` (in force now) |
| `GET /status` | per ride type: normal or peak right now, base and current per-km |
| `GET /:id` | one slot |
| `POST /` | create (`name, startTime, endTime, hikePercent, appliesToAll, rideTypes, isActive`) |
| `PATCH /:id` | edit; 409 `PEAK_SLOT_CHANGED` if another admin edited it meanwhile |
| `PATCH /:id/status` | enable or disable |
| `DELETE /:id` | only a disabled slot (`PEAK_SLOT_STILL_ACTIVE` otherwise) |

Errors: `PEAK_SLOT_INVALID` (400), `PEAK_SLOT_OVERLAP`, `PEAK_SLOT_NAME_TAKEN`, `PEAK_SLOT_CHANGED`, `PEAK_SLOT_STILL_ACTIVE` (409), `PEAK_SLOT_NOT_FOUND` (404).

Every create, edit, enable, disable and delete is written to the audit log (`targetType: PEAK_SLOT`) with the values before and after.

## Estimate and ride responses
`POST /rides/estimate`, `/rides/estimate/all`, `POST /rides` and `GET /rides/:id` return, in `fare`: `perKmRate` (charged), `basePerKmRate`, and `peak { name, hikePercent, startTime, endTime, surcharge }` when a peak applied. `surcharge` is the extra distance charge in rupees. A ride booked with a peak also records the slot name and hike in its first transition's metadata.

## Apps
- **Admin panel**: Pricing → Peak hours. A status panel (CURRENTLY NORMAL / PEAK PRICING with the per-km rate per ride type), the slot table (name, time, hike, ride types, enable switch, edit, delete) and an add/edit form with a live preview of the new per-km rate and a 10 km / 15 min sample fare for each ride type. Ride detail shows the frozen peak. Audit log has a Peak slot filter.
- **Rider app**: the "Choose a ride" list shows a Peak tag per ride and a banner while any ride is at a peak rate; the fare breakdown (shared by booking, tracking, payment, receipt and the driver's ride screen) explains "Peak pricing +50% (₹18 → ₹27/km)".

## Operations notes
- Writes are serialised per API node and checked with a version, so two admins cannot create overlapping slots from one node. With several API nodes, two simultaneous creates could in theory both pass: run slot edits from one admin at a time, or add a distributed lock.
- The pricing hot path caches the active slots for up to 5 seconds per node; a write clears the cache on the node that handled it, so other nodes pick it up within 5 seconds.
- A slot cannot cover the whole day (start equals end is invalid); use 00:00 – 23:59 and a second slot for 23:59 – 00:00 if ever needed.
- Peak pricing never changes a ride after booking. If the customer saw a lower estimate before a peak began, the booking response shows the price they were actually given.
