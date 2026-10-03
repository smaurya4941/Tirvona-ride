# Commission per ride type

Tests: `test/commission-ride-types.e2e-spec.ts` (rates, versions, dates, conflicts, audit, snapshot, refund, migration), `test/phase4.e2e-spec.ts` (Commission block, payment-driven earnings), `src/modules/earnings/commission.spec.ts` (the split).

## Rules
1. **Commission belongs to the ride type** (Bike, Auto, Cab, and any ride type added later), never to a driver. The ride type list is the existing `ride_types` collection; there is no second list.
2. **Each ride type has its own rate, version numbers and history** (Bike v3, Auto v2, Cab v5).
3. **Commission is a percentage of the final fare.** ₹500 at 15% → Tirvona ₹75, driver ₹425. The commission is rounded half-up to the paisa and the driver gets the exact remainder.
4. **Changes are versioned.** An edit appends a version; nothing is overwritten. The version in force is the ACTIVE one with the latest `effectiveFrom` not after the time asked about.
5. **Scheduled changes.** Leave *Effective from* empty to apply now, or pick a future time. Until then the current rate applies. Back-dating is refused (beyond a 5-minute clock-skew allowance).
6. **No ambiguity.** Two live versions of one ride type cannot start at the same instant (409 `COMMISSION_VERSION_CONFLICT`; a cancelled version frees its time). Changing to the rate already in force at that time is refused (400 `COMMISSION_UNCHANGED`).
7. **Finalised rides never change.** The earning line written for a ride is immutable and stores the ride type, rate, version, config id, commission and driver share. Later rate changes do not touch it. Refunds claw back from that line's own rate, never the current one.

## Which time decides the rate
The rate is the one in force **when the ride was completed** (`rideCompletedAt`), not when the payment was captured. A ride that finished at 11:58 PM before a midnight change keeps the old rate even if the customer pays at 12:03 AM. Cash rides are recorded at completion, so the two moments coincide.

## Resolver
`CommissionService.resolve(rideType, at)` is the single source of truth. If the ride type has no version yet it is created (see migration); for a time before a ride type's first version (history from before the migration) the earliest version applies. `EarningsService.recordForPayment` is its only caller on the money path, so payment, refund and reconciliation all read the stored snapshot rather than asking again.

## Data
`commission_configs`: `rideType`, `version`, `type`, `value` (0–100, two decimals), `effectiveFrom`, `status` (ACTIVE | CANCELLED), `note`, `createdBy`, `cancelledBy/At`. Unique `(rideType, version)`, and unique `(rideType, effectiveFrom)` for ACTIVE rows.

`driver_earnings` is unchanged: it already carried `rideType`, `commissionRate`, `commissionPaise`, `netEarningPaise`, `commissionConfigId` and `commissionVersion`, all immutable.

## Migration (automatic, on API start)
- The old unique index on `version` alone is dropped (it would reject Bike v1 next to Cab v1).
- Every ride type that has no commission gets a copy of the old global history, version for version, with the same dates, notes and statuses. Each ride type therefore starts at exactly the rate it paid before (e.g. 10% for all three), and old earnings' `commissionVersion` numbers still match the copies.
- The old global rows stay in place (earlier earnings point at them) and are ignored by the resolver.
- A fresh database starts every ride type at `DEFAULT_COMMISSION_PERCENT`.
- A ride type created later gets its history when it is created (and, as a safeguard, the first time a ride of that type is priced).
- Existing earnings are not recalculated.

## Admin API (`/admin/commission`, admin only)
| Route | |
|---|---|
| `GET /` | every ride type with `current` and `scheduled` |
| `GET /:rideType` | one ride type: current, scheduled and full `history` |
| `GET /:rideType/history` | versions, newest first, each `CURRENT / SCHEDULED / SUPERSEDED / CANCELLED` |
| `PATCH /:rideType` | `{ value, effectiveFrom?, note? }` creates the next version |
| `POST /:id/cancel` | withdraw a scheduled version that has not started |

Errors: `RIDE_TYPE_NOT_FOUND` (404), `COMMISSION_VERSION_CONFLICT`, `COMMISSION_NOT_CANCELLABLE` (409), `COMMISSION_UNCHANGED`, `VALIDATION_FAILED` (400).

The old global routes (`GET/PATCH /admin/commission`, `GET /admin/commission/history`) are gone. Nothing outside the admin panel used them.

Every change is audited (`targetType: COMMISSION`, `targetId`: the ride type): `commission.update` records who, the ride type, old rate, new rate, version, effective time and whether it was scheduled; `commission.cancel` records the withdrawn version.

Drivers and customers have no access. Drivers only see the rate captured on their own earning lines.

## Admin panel
**Commission** shows one card per ride type (current rate, active since, scheduled change, Edit). **Edit** opens that ride type's page: current and scheduled rate, the edit form with the ride type shown, and its version history with Cancel for scheduled versions. Payment detail ("Commission split") and driver earnings show the ride type, rate and version each line used. The audit log can filter by Commission.
