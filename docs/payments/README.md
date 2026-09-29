# Razorpay integration v2 — final fare, refunds, clawbacks, reconciliation

Builds on Phase 4 (`docs/phase-4/README.md`: orders, checkout, verification,
webhooks, commission, earnings, cash). This stage completes the payment
architecture:

```
Ride completed ──► FINAL FARE ENGINE (actual trip) ──► frozen fare snapshot (ride.fare.final)
                                                            │
                                     Payment (payable = final − promo) ──► Razorpay order ──► Checkout
                                                            │
                               verify (app)  +  webhook (Razorpay)  +  reconciler (timer)
                                                            ▼
                     CAPTURED ──► ride SUCCESS ──► earning line (commission snapshot)
                        │
      admin refund ─────┤  full / partial / duplicate      Razorpay dashboard refund (webhook / sync)
                        ▼
      payment_refunds ──► payment totals (recomputed) ──► ride REFUNDED / PARTIALLY_REFUNDED
                        └─► driver clawback (driver_earning_adjustments) ──► recovered from next payout
                                                            │
                     reconciliation runs (Razorpay ↔ MongoDB), live exceptions, audit
```

**Ride decides how much. Payments decide how it is collected, verified,
refunded and reconciled. Flutter decides nothing about money.**

## 1. Final fare from the actual trip

`RideLifecycleService.complete` now prices the ride with the tariff frozen at
booking (`fare.pricingVersion`, never today's tariff) on the *actual* trip:

| Input | Source |
| ----- | ------ |
| Duration | Server timestamps `startedAt → completedAt` |
| Distance | The trip trail (`driver_location_checkpoints`: STARTED + TRIP samples + the live drop fix), measured by `measureTrip` |
| Fallback | The booked route's distance when the trail is unreliable: < 2 points, a gap > `TRIP_METER_MAX_GAP_SECONDS`, or > 25 % GPS jumps |
| Cap | Final fare ≤ `FINAL_FARE_MAX_ESTIMATE_MULTIPLIER` × the estimate the customer accepted (default 1.5) |

GPS jumps (a leg faster than 45 m/s) are skipped, not billed. Trail samples are
now taken every `RIDE_CHECKPOINT_INTERVAL_SECONDS` = 15 s (was 60 s).

The result is frozen on the ride as `fare.final`: distance + duration (and
whether each was measured or booked), the trail distance even when not
billed, base / distance / time components, minimum-fare and cap flags, the
uncapped figure, discount, payable, tariff version, mode and timestamp. The
payment is created for `fare.payableFare ?? fare.finalFare` — never the
estimate, never an app-supplied amount. `FINAL_FARE_MODE=booked` restores the
old behaviour (bill the booked route).

Apps: the pay screen and receipt show *Priced on your actual trip* with the
measured distance/time, and *Capped at 1.5 × your estimate* when the cap
applied. Admin payment detail has a **Final bill** card.

## 2. Refunds

Admin → Payments → payment → **Refund** (or `POST /admin/payments/:id/refunds`).

```json
{ "amount": 50, "reason": "FARE_ADJUSTMENT", "note": "Driver took a detour",
  "driverImpact": "PROPORTIONAL", "idempotencyKey": "<uuid>" }
```

- Omit `amount` for a full refund of what remains. Min ₹1, max = captured −
  (processed + requested + pending) refunds.
- Reasons: `FARE_ADJUSTMENT`, `RIDE_CANCELLED`, `CUSTOMER_SUPPORT`,
  `ADMIN_REFUND`, `SYSTEM_ERROR`, `DUPLICATE_PAYMENT` (`EXTERNAL` is reserved
  for dashboard refunds).
- `driverImpact` defaults by reason: fare adjustment / cancellation / admin →
  `PROPORTIONAL` (driver shares it), support / system / duplicate → `NONE`
  (Tirvona bears it).
- Refunds go to the original payment method (Razorpay's rule), at normal speed.
- Cash payments are refused (`409 REFUND_NOT_SUPPORTED`); settle cash
  directly with the customer. Payments older than `PAYMENT_REFUND_WINDOW_DAYS`
  (180) are refused (`REFUND_WINDOW_EXPIRED`).

### Lifecycle (`payment_refunds.status`)

```
REQUESTED ──(Razorpay accepted)──► PENDING ──► PROCESSED
    │                                  └────► FAILED
    └──(Razorpay rejected / never registered it)──► FAILED
```

| Situation | What happens |
| --------- | ------------ |
| Razorpay answers | Status from Razorpay (`pending` / `processed`), Razorpay refund id and bank reference (ARN/RRN) stored |
| Razorpay rejects (4xx) | Record `FAILED` with Razorpay's reason, amount freed, admin gets `502 REFUND_REJECTED` |
| Timeout / 5xx | Stays `REQUESTED`; the reconciler lists the payment's refunds at Razorpay and matches ours by `notes.tirvonaRefundId` (a lost response is found, never re-sent). Not found after 15 min → `FAILED` ("no money was returned") |
| Webhook `refund.created/processed/failed` | Applied to the record (found by Razorpay id, then by our id in the notes) |

### Money safety

| Guard | How |
| ----- | --- |
| No over-refund | Per-payment `refundLockUntil` serialises requests; refundable computed from all active refunds under the lock |
| No double refund on retry | `idempotencyKey` unique (the panel generates one per dialog) |
| One record per Razorpay refund | `razorpayRefundId` unique |
| Totals never drift | `refundAmountPaise`, `refundPendingPaise`, `refundStatus` (NONE/PENDING/PARTIAL/FULL/FAILED) and the payment status are **recomputed** from `payment_refunds` under a `refundSeq` compare-and-set — replayed or reordered webhooks converge |
| Revenue vs duplicates | Duplicate-capture refunds (`target: DUPLICATE_CAPTURE`, full amount only) never touch the payment's totals, status or the driver |

Payment status follows processed refunds: `CAPTURED → PARTIALLY_REFUNDED →
REFUNDED`; the ride's `paymentStatus` follows (`ride.payment.refundedAmount`).

### Dashboard refunds

A refund made in the Razorpay dashboard for a Ride payment arrives by webhook
(or reconciliation), is recorded as `EXTERNAL` with `needsReview`, and shows in
Admin → Refunds / Reconciliation. **Review** decides the driver impact; only
then is a clawback written. Refunds of payments that are not Ride payments (the
main Tirvona app on the same Razorpay account) are ignored.

## 3. Driver clawbacks

Earning lines stay immutable. A processed refund with `PROPORTIONAL` impact
writes one `driver_earning_adjustments` line (unique per refund):

```
fraction   = refund / amount the customer paid
gross      = round(earning.gross × fraction)
commission = round(earning.commission × fraction)   ← the ride's own rate, not today's
deduction  = gross − commission
```

The refund that completes a full refund reverses exactly what is left, so
partials that add up to the whole leave no rounding residue. ₹70 of a ₹350
ride at 20 % → driver −₹56.

Adjustments are `OUTSTANDING` until recovered:

- **Next payout**: `POST /admin/earnings/payouts` deducts outstanding
  adjustments (oldest first, whole adjustments that fit). The payout stores
  `grossAmount`, `deductionAmount`, `adjustmentIds`; `amount` is what was
  transferred. `POST /admin/earnings/payouts/preview` shows it beforehand
  (the panel's payout dialog uses it).
- **Waive**: `POST /admin/earnings/adjustments/:id/waive {note}` — Tirvona
  bears it.

Drivers see *Refund deductions* on the Earnings tab and on the earning detail
("You keep ₹X"), and get an *Earnings adjusted* notification. Balances gain
`deductions` (outstanding).

## 4. Reconciliation

Three layers, all healing through the normal settlement paths:

1. **Every minute** (`PaymentsReconciler`, `PAYMENT_RECONCILE_INTERVAL_MS`):
   stuck `PROCESSING` payments; *open orders nobody told us about* (order
   raised 30 min – 3 days ago, re-checked every 30 min — app killed and
   webhook lost); missing earnings; unsettled refunds (every 2 min); missing
   clawbacks.
2. **Daily run** (`PAYMENT_DAILY_RECONCILIATION`, after
   `PAYMENT_DAILY_RECONCILIATION_HOUR` local): yesterday, end to end,
   exactly once (`key: daily:YYYY-MM-DD`, unique).
3. **Admin runs**: Admin → Reconciliation → *Run reconciliation* for a window
   ≤ `PAYMENT_RECONCILIATION_MAX_DAYS` (runs in the background; the page polls).

A run lists every Razorpay payment created in the window (100 per page, up to
5,000), keeps the Ride ones (order known to us, or `notes.app = tirvona-ride`),
and checks every online payment we recorded as paid in the window:

| Exception | Severity | Auto-heal |
| --------- | -------- | --------- |
| `GATEWAY_PAID_NOT_RECORDED` | critical → warning when healed | yes (captured through `applyGatewayPayment`: ride + earning) |
| `RECORDED_PAID_NOT_AT_GATEWAY` | critical | no |
| `AMOUNT_MISMATCH` | critical | no (never marked paid) |
| `UNTRACKED_DUPLICATE` | warning | recorded as a duplicate capture (refund it) |
| `REFUND_MISMATCH` | warning / info | refunds re-synced from Razorpay |
| `AUTHORIZED_NOT_CAPTURED` | info | captured if the ride is still open |
| `UNKNOWN_ORDER` | warning | no |

Unhealed exceptions can be *Marked resolved* with a note. The live
**Needs attention** list (`GET /admin/payments/exceptions`) also shows:
unrefunded duplicates, flagged/failed webhooks, failed and stuck refunds,
dashboard refunds to review, missing earnings, stale processing, pending
clawbacks and unresolved run exceptions.

Every Razorpay order, checkout and refund carries `notes.app = "tirvona-ride"`,
so Ride money is always distinguishable on the shared account.

## 5. Audit trail

- `payments.events` entries now carry `fromStatus`, `toStatus`, `actorId`,
  `amountPaise`, `refundId` (e.g. `PAYMENT_CAPTURED CREATED → CAPTURED`,
  `REFUND_REQUESTED`, `REFUND_PROCESSED`, `EARNING_ADJUSTED`,
  `REFUND_EXTERNAL`, `REFUND_REVIEWED`, `CASH_SELECTED`).
- Admin actions go to the admin audit log: `payment.refund`,
  `payment.refund_failed`, `payment.refund_review`,
  `payment.reconciliation_run`, `payment.reconciliation_resolve`,
  `earnings.adjustment_waive`.

## 6. API

| Method | Path | Who |
| ------ | ---- | --- |
| POST | `/api/v1/payments/webhook/razorpay` (and the Phase 4 `/payments/webhook`) | Razorpay (HMAC) |
| GET | `/api/v1/payments/:id` — receipt now has `refunds[]`, `refund.pending`, `ride.fare.final` | customer |
| GET | `/api/v1/earnings`, `/earnings/:id` — `adjustments`, `balances.deductions` | driver |
| POST | `/api/v1/admin/payments/:id/refunds` | admin |
| GET | `/api/v1/admin/payments/refunds?status&reason&needsReview` | admin |
| POST | `/api/v1/admin/payments/refunds/:refundId/review` | admin |
| GET | `/api/v1/admin/payments/exceptions` | admin |
| GET / POST | `/api/v1/admin/payments/reconciliation/runs` | admin |
| GET | `/api/v1/admin/payments/reconciliation/runs/:runId` | admin |
| POST | `/api/v1/admin/payments/reconciliation/runs/:runId/exceptions/:exceptionId/resolve` | admin |
| POST | `/api/v1/admin/payments/:id/reconcile` — now also re-syncs refunds | admin |
| POST | `/api/v1/admin/earnings/payouts/preview` | admin |
| POST | `/api/v1/admin/earnings/adjustments/:id/waive` | admin |

New error codes: `REFUND_*` (`NOT_FOUND`, `NOT_ALLOWED`, `NOT_SUPPORTED`,
`WINDOW_EXPIRED`, `TARGET_INVALID`, `AMOUNT_INVALID`, `NOTHING_LEFT`,
`IN_PROGRESS`, `REJECTED`, `IDEMPOTENCY_CONFLICT`, `ALREADY_REVIEWED`),
`RECONCILIATION_*`, `ADJUSTMENT_NOT_FOUND`, `ADJUSTMENT_NOT_OUTSTANDING`.

Notifications: `REFUND_INITIATED`, `REFUND_PROCESSED` (customer → receipt),
`EARNING_ADJUSTED` (driver).

## 7. Configuration

| Variable | Default | Notes |
| -------- | ------- | ----- |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | — | Test keys `rzp_test_…` outside production (live keys refused) |
| `RAZORPAY_WEBHOOK_SECRET` | — | The secret set on the dashboard webhook |
| `FINAL_FARE_MODE` | `actual` | `actual` or `booked` |
| `FINAL_FARE_MAX_ESTIMATE_MULTIPLIER` | 1.5 | 0 = no cap; otherwise 1–10 |
| `TRIP_METER_MAX_GAP_SECONDS` | 120 | |
| `RIDE_CHECKPOINT_INTERVAL_SECONDS` | 15 | was 60 |
| `PAYMENT_REFUND_WINDOW_DAYS` | 180 | 1–365 |
| `PAYMENT_DAILY_RECONCILIATION` | true | |
| `PAYMENT_DAILY_RECONCILIATION_HOUR` | 3 | local hour (`APP_TIME_ZONE`) |
| `PAYMENT_RECONCILIATION_MAX_DAYS` | 31 | |

New collections: `payment_refunds`, `driver_earning_adjustments`,
`payment_reconciliation_runs`. `payments`, `driver_payouts` and
`rides.fare` gain fields; old documents read with safe defaults (no migration).

## 8. Going live with your Razorpay account

1. Razorpay dashboard in **Test Mode** → Account & Settings → API Keys →
   generate. Put them in `Tirvona_ride/.env`: `RAZORPAY_KEY_ID=rzp_test_…`,
   `RAZORPAY_KEY_SECRET=…`. The secret never goes into the app — the app gets
   the key id from `/payments/create`.
2. Dashboard → Webhooks → Add: URL
   `https://<api-host>/api/v1/payments/webhook/razorpay`, secret of your choice
   (also in `RAZORPAY_WEBHOOK_SECRET`), events: `payment.authorized`,
   `payment.captured`, `payment.failed`, `order.paid`, `refund.created`,
   `refund.processed`, `refund.failed`. Locally, expose port 5100 with a tunnel
   (`cloudflared tunnel --url http://localhost:5100`).
3. Restart the API; the log says `Razorpay is in TEST mode`.
4. Production: `.env.production` with `rzp_live_…` keys, a live-mode webhook
   with its own secret, `NODE_ENV=production`. Never put live keys in
   development.

The same Razorpay account can serve the main Tirvona app: Ride code only acts
on orders, payments and refunds it created (webhooks for anything else are
`IGNORED`).

## 9. Testing

```powershell
npm test                                           # unit: trip meter, clawback math, env rules, …
npm run test:e2e -- test/payments-v2.e2e-spec.ts   # 19 e2e cases
npm run test:e2e                                   # everything (older suites run FINAL_FARE_MODE=booked)
```

`test/support/fake-razorpay.ts` is an in-memory Razorpay (orders, payments,
refunds with pending/processed, over-refund rejection, lost responses,
dashboard refunds, other-app payments, listing). The suite covers: actual-trip
fare, booked fallback and cap; admin-only refunds; amount validation; partial
refund pending → processed by webhook; redelivered webhooks; idempotent retry;
concurrent full refunds (exactly one wins); rejected and lost refunds;
dashboard refund review; duplicate-capture refund; cash refused; clawback
math, payout deductions and waiver; reconciliation run healing a silent
payment and ignoring other apps; background sweep of silent orders; daily run
exactly once; summary figures; audit log.

### Manual (Razorpay Test Mode)

1. Complete a ride (drive a little with the driver app so the trail exists)
   and pay with UPI `success@razorpay`.
2. Admin → Payments → the payment → **Refund** → Partial ₹20, *Fare
   adjustment*, *Driver shares it*. Status *Processing*, then *Refunded* when
   Razorpay's webhook arrives. The customer receipt shows the refund; the
   driver's Earnings tab shows the deduction.
3. Admin → Driver earnings → driver → select → **Mark as paid**: the dialog
   shows the deduction and the transfer amount.
4. Admin → Reconciliation → *Run reconciliation* for today → *Clean*.

## Not in this stage

Automatic driver bank payouts (Razorpay Route/X), instant refunds,
chargebacks/disputes, cancellation-fee collection online, peak/time-of-day
pricing (the pricing engine has none yet), and a tax engine.
