# Phase 4 — Payments & driver earnings

A completed ride now has a bill. The customer pays the **server-calculated
final fare** through Razorpay Standard Checkout, NestJS verifies the payment
itself, the ride is marked paid, and exactly one immutable earning line is
written for the driver at the commission rate in force. Admins see every
payment, own the commission rate, and record manual payouts.
**Razorpay processes money; NestJS remains the business authority.**

```
Driver: Complete ──► ride COMPLETED, fare.finalFare, paymentStatus PENDING
Customer app ──POST /payments/create──► NestJS ──create order (final fare)──► Razorpay
Customer app ◄── checkout {key, orderId, amount} ──
Customer app ── Razorpay Checkout (UPI / card / netbanking / wallet) ──► Razorpay
Customer app ──POST /payments/verify {order, payment, signature}──► NestJS
                                   │ HMAC signature ✔  Razorpay says captured ✔  amount = fare ✔
Razorpay ──POST /payments/webhook (HMAC over raw body)──► NestJS   (independent 2nd path)
                                   ▼
             payment CAPTURED → ride paymentStatus SUCCESS → driver earning (once)
                                   ▼
             admin: payments · commission · driver earnings → mark payout PAID
```

| Part   | New in Phase 4 |
| ------ | -------------- |
| API    | `payments/` (Razorpay gateway, verify, webhook, reconciler, admin reads); `earnings/` (commission versions, earnings ledger, payouts); `ride.paymentStatus` + `ride.payment`; `ride.payment_updated` event; driver dashboard `today.earnings` |
| Mobile | `features/customer/payments/` (payment screen, Razorpay checkout, receipt, Payments tab); `features/driver/earnings/` (Earnings tab, earning detail); pay prompts on ride details, history and home |
| Admin  | Payments (list, filters, detail + audit trail), Commission (current, edit, schedule, history), Driver earnings (per driver, ledger, manual payouts); payment status on ride detail |

## Ride completion ≠ payment

`RideStatus` is unchanged. Money lives in a separate field, `ride.paymentStatus`:

```
NOT_REQUIRED ──(ride COMPLETED, final fare set)──► PENDING
PENDING / FAILED ──(order created)──► ORDER_CREATED
ORDER_CREATED ──(Razorpay holds a payment not yet confirmed)──► PROCESSING
ORDER_CREATED / PROCESSING ──(verified + captured)──► SUCCESS   ← ride financially closed
ORDER_CREATED / PROCESSING ──(declined / closed)──► FAILED ──► retry
SUCCESS ──(refund synced from Razorpay)──► REFUNDED / PARTIALLY_REFUNDED
```

`NOT_REQUIRED` covers rides with nothing to pay: still in progress,
cancelled, or never matched. Rides completed **before** Phase 4 still hold
the schema default and are treated as `PENDING` (`effectivePaymentStatus`).
Every write after completion goes through `RidePaymentStateService` — a
compare-and-set that bumps `stateVersion` and publishes
`ride.payment_updated` to the customer and driver user rooms.

The payment record (`payments.status`) follows Razorpay:
`CREATED → AUTHORIZED → CAPTURED`, or `FAILED`, then
`REFUNDED / PARTIALLY_REFUNDED`.

## Money rules

- **The app never sends an amount or a method.** `POST /payments/create`
  takes only `rideId`; extra fields are rejected (400). The order is created
  for `ride.fare.finalFare`, the fare `RideLifecycleService.complete` wrote.
- All stored money is **integer paise** (`amountPaise`, `grossFarePaise`,
  `commissionPaise`, `netEarningPaise`). The API speaks rupees.
- The payment method stored is what **Razorpay** reports, never the app.
- No card number, CVV, UPI PIN, VPA or bank credential is ever stored — only
  Razorpay references (order id, payment id, signature, card last 4).

## Verification (`POST /payments/verify`)

In order — any failure leaves the ride unpaid:

1. The payment is looked up **scoped to the calling customer** (rule 3: wrong customer → 404).
2. The Razorpay order must be one of this payment's attempts (rules 1–2: `PAYMENT_ORDER_MISMATCH`).
3. `HMAC_SHA256(order_id|payment_id, key_secret)` must equal the signature (rule 5: `PAYMENT_SIGNATURE_INVALID`).
4. Already captured with the same Razorpay payment id → returned as-is (rule 6, idempotent).
5. The Razorpay payment id must not be attached to any other ride (rule 8: `PAYMENT_ID_REUSED`, also a unique index).
6. **Razorpay is asked** for the payment: its `order_id` must match, and
   amount + currency must equal the fare (rule 4: `PAYMENT_AMOUNT_MISMATCH`).
   `authorized` payments are captured for exactly the fare.
7. The capture is a compare-and-set on `status ∈ {CREATED, AUTHORIZED, FAILED}`;
   a second successful payment on an already-paid ride (rule 7) is recorded
   as a **duplicate capture** needing a manual refund, never as revenue. An
   uncaptured duplicate authorisation is deliberately left uncaptured, so
   Razorpay auto-refunds it.

If Razorpay cannot be reached in step 6, the signature already proves the
payment exists: the ride goes to `PROCESSING` and the app shows "Confirming
your payment". The webhook, the reconciler, or the app's next read of
`GET /payments/:id` settles it. A new order is refused (`PAYMENT_IN_PROGRESS`)
while a payment is in flight, so the customer cannot be charged twice.

## Webhook (`POST /api/v1/payments/webhook`)

- Public route (no JWT) authenticated by `X-Razorpay-Signature` =
  HMAC-SHA256 over the **raw request body** with `RAZORPAY_WEBHOOK_SECRET`.
  `main.ts` creates the app with `rawBody: true` for this.
- Deduplicated by `X-Razorpay-Event-Id` in `payment_webhook_events`
  (TTL 180 days). A redelivery returns `DUPLICATE`; an event whose
  processing threw is marked `FAILED` and reprocessed on Razorpay's retry
  (we answer 5xx). Events that contradict our records (amount/order
  mismatch) are marked `FLAGGED` and answered 200, since retrying cannot fix them.
- Handled: `payment.authorized`, `payment.captured`, `payment.failed`,
  `order.paid`, `refund.processed`, `refund.failed`. They go through the
  same `applyGatewayPayment` as `/verify`.

Dashboard setup (Test Mode): **Settings → Webhooks → Add**, URL
`https://<api-host>/api/v1/payments/webhook`, the events above, and a secret
that you also put in `RAZORPAY_WEBHOOK_SECRET`. For local development, expose
port 5100 with a tunnel (e.g. `cloudflared tunnel --url http://localhost:5100`).

## Idempotency — one payment, one earning

| Guard | Where |
| ----- | ----- |
| One payment per ride | unique `payments.rideId` |
| A Razorpay payment settles one ride | unique partial index on `payments.razorpayPaymentId` |
| One order at a time | per-payment `orderLockUntil` lock; open orders are **re-used** for retries (`PAYMENT_ORDER_REUSE_MINUTES`) |
| One capture | CAS on payment `status` |
| One ride SUCCESS | CAS on `ride.paymentStatus` |
| One earning per ride | unique `driver_earnings.rideId` and `.paymentId`; losers of the race read the winner |
| One webhook processing | unique `payment_webhook_events.eventId` |

The e2e suite runs duplicate verifies, repeated webhooks (same and different
event ids) and the verify-vs-webhook race, and asserts one earning each time.

## Reconciler

`PaymentsReconciler` runs every `PAYMENT_RECONCILE_INTERVAL_MS` (0 = off):

- payments stuck in PROCESSING longer than `PAYMENT_PROCESSING_STALE_SECONDS`
  are re-checked with Razorpay (`GET /orders/:id/payments`);
- captured payments whose earning insert failed get their earning;
- earnings past their settlement window move PENDING → AVAILABLE.

Admins can trigger a check for one payment: `POST /admin/payments/:id/reconcile`.

## Commission & earnings

- Commission is **versioned** (`commission_configs`): every admin change is a
  new version with `effectiveFrom` (now or future, never back-dated). The
  rate in force at time T = latest ACTIVE version with `effectiveFrom ≤ T`.
  A scheduled change can be cancelled before it starts. V1 supports
  `PERCENTAGE` only. The first boot seeds v1 from `DEFAULT_COMMISSION_PERCENT` (20).
- An earning line (`driver_earnings`) is written when the payment is captured:
  `commission = round_half_up(gross × rate)`, `driver = gross − commission`
  (₹350 at 15% → ₹52.50 / ₹297.50). The rate, amounts and commission version
  are stored on the line, and every financial field is Mongoose-`immutable`.
  Changing the commission never alters history.
- Earning status: `PENDING` (inside `EARNINGS_HOLD_HOURS`) → `AVAILABLE` →
  `PAID`. With the default hold of 0, earnings are AVAILABLE immediately.
- Driver "today / week / month" use the ride's completion time in
  `APP_TIME_ZONE` (weeks start on Monday).

## Manual payouts

V1 moves no money to drivers. An admin transfers it outside the platform, then
records it:

- `POST /admin/earnings/:id/mark-paid` — one earning.
- `POST /admin/earnings/payouts` — several AVAILABLE earnings of one driver
  (the admin panel's "Mark N as paid").

Both require a `payoutReference` (bank/UPI reference) and accept a `note`.
Each creates a `driver_payouts` record (who, when, reference, amount, lines)
and stamps each earning with `status PAID`, `paidAt`, `paidBy`,
`payoutReference`, `payoutNote`. Only AVAILABLE lines of that driver are
accepted, and the flip is conditional, so two admins cannot pay a line twice.

## API

| Method | Path | Who |
| ------ | ---- | --- |
| POST | `/api/v1/payments/create` `{rideId}` | customer |
| POST | `/api/v1/payments/verify` `{paymentId, razorpayOrderId, razorpayPaymentId, razorpaySignature}` | customer |
| POST | `/api/v1/payments/:id/failure` (advisory: checkout failed/closed) | customer |
| GET | `/api/v1/payments/history` | customer |
| GET | `/api/v1/payments/:id` (receipt) | customer |
| POST | `/api/v1/payments/webhook` | Razorpay (HMAC) |
| GET | `/api/v1/earnings?period=today\|week\|month\|all&status=` | driver |
| GET | `/api/v1/earnings/:id` | driver |
| GET | `/api/v1/admin/payments` `?status&from&to&ride&customer&driver&payment` | admin |
| GET | `/api/v1/admin/payments/summary` | admin |
| GET | `/api/v1/admin/payments/:id` | admin |
| POST | `/api/v1/admin/payments/:id/reconcile` | admin |
| GET / PATCH | `/api/v1/admin/commission` | admin |
| GET | `/api/v1/admin/commission/history` | admin |
| POST | `/api/v1/admin/commission/:id/cancel` | admin |
| GET | `/api/v1/admin/earnings` `?search` · `/admin/earnings/summary` | admin |
| GET | `/api/v1/admin/earnings/:driverId` `?status&page` | admin |
| POST | `/api/v1/admin/earnings/:id/mark-paid` · `/admin/earnings/payouts` | admin |

Realtime: `ride.payment_updated` (customer + driver user rooms) with the
recipient's ride view, whenever `ride.paymentStatus` changes.

## Configuration

Settings files are chosen by `NODE_ENV` (real environment variables always win):
`development → .env.local, .env` · `test → .env.test` ·
`production → .env.production, .env`. Examples: `.env.example`,
`.env.test.example`, `.env.production.example`. None of the real files are
committed (`.gitignore`).

| Variable | Default | Notes |
| -------- | ------- | ----- |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | — | Test keys `rzp_test_…`. **Live keys `rzp_live_…` are refused unless `NODE_ENV=production`.** Required in production. Unset in development → `/payments/create` answers 503 `PAYMENT_GATEWAY_NOT_CONFIGURED`. |
| `RAZORPAY_WEBHOOK_SECRET` | — | Required in production (≥ 12 chars) |
| `RAZORPAY_API_BASE_URL` | `https://api.razorpay.com/v1` | |
| `RAZORPAY_TIMEOUT_MS` | 10000 | Every Razorpay call has a hard timeout |
| `PAYMENT_BRAND_NAME` | Tirvona Rides | Checkout title |
| `PAYMENT_ORDER_REUSE_MINUTES` | 60 | Retries re-use the open order |
| `PAYMENT_RECONCILE_INTERVAL_MS` | 60000 | 0 disables |
| `PAYMENT_PROCESSING_STALE_SECONDS` | 60 | |
| `DEFAULT_COMMISSION_PERCENT` | 20 | Seeds v1 only |
| `EARNINGS_HOLD_HOURS` | 0 | Settlement window |

## MongoDB collections added

`payments`, `payment_webhook_events`, `driver_earnings`, `commission_configs`,
`driver_payouts`; `rides` gains `paymentStatus` and `payment`.

## Mobile

- **Customer:** when the driver completes, the tracking screen opens **Pay**
  (`/customer/rides/:id/pay`): the final fare, the real fare breakdown (no
  invented taxes), and "Pay ₹X". Razorpay Checkout (`razorpay_flutter`) opens
  with the server's order. On success the app calls `/verify` and shows
  *Payment successful* only when the server confirms. On failure it shows
  *Payment failed … Try again* (same order re-used). If the result is unknown
  (network loss, UPI app hand-off) it shows *Confirming your payment* and
  polls the receipt plus listens for `ride.payment_updated` — it never says
  "failed" when money may have moved. Also: Payments tab (history), in-app
  receipt (`/customer/payments/:id`), "Paid ✓ / Pay now" on ride details and
  history, and a "Payment pending" card on Home.
- **Driver:** the Home card shows Today's rides, **Today's earnings** (net,
  paid rides) and Rating. The **Earnings** tab shows today / this week /
  total, Available / Pending / Paid balances, a period filter and the ledger.
  Earning detail shows gross − commission (rate) = your earnings and payout
  reference. The completed-ride screen shows live "Customer has paid".
- Android release builds keep Razorpay's classes via
  `android/app/proguard-rules.pro`.

## Testing

```powershell
npm test                                         # unit: commission split, signatures, periods, env rules
npm run test:e2e -- test/phase4.e2e-spec.ts      # 36 e2e cases (in-memory MongoDB, fake Razorpay)
```

The e2e suite swaps `RazorpayGateway` for an in-memory fake with the same
contract, and signs everything with real HMACs. It covers the full testing
matrix: success, failure, retry on the same order, invalid signature,
foreign order, wrong customer, wrong amount, payment reuse across rides,
already-paid ride, duplicate verify, duplicate webhooks, webhook-only
settlement, Razorpay outage → PROCESSING → reconciled, commission change
applied only to new earnings, scheduled change and its cancellation, driver
totals and scoping, admin filters, audit trail, and single + bulk payouts.

### Manual end-to-end (Razorpay Test Mode)

1. Put your **Test Mode** keys and webhook secret in `.env.local`; start the API
   and the admin panel; run the app on two phones (customer, driver).
2. Driver goes online → customer books → Accept → Arrive → Start (OTP) → Complete.
3. The customer's app opens *Pay ₹X*. Pay with a test instrument, e.g. UPI
   `success@razorpay` (use `failure@razorpay` to see *Payment failed → Try again*),
   or test card `4111 1111 1111 1111`, any future expiry, any CVV.
4. Check: ride shows *Paid ✓*; the driver sees *Customer has paid* and the
   earning in **Earnings**; admin **Payments** lists the payment with its
   Razorpay ids; **Driver earnings** shows the commission split.
5. Admin → Driver earnings → driver → select → **Mark as paid** with a
   reference → the driver's Paid balance updates.

## Not in Phase 4 (by design)

Automatic driver bank transfers / Razorpay Route, wallets, subscriptions,
EMI, international payments, multiple gateways, a tax engine, automated or
partial refunds, and chargebacks. Refunds made in the Razorpay dashboard
**are** synced (payment and ride status), but the driver's earning line is
immutable: the API logs a warning so the earning can be reviewed before payout.

## Follow-ups worth considering

- Blocking a new booking while the customer has an unpaid completed ride
  (currently they can book again; home shows "Payment pending").
- Using actual trip distance and time for the final fare. Completion still
  prices the booked route, as in Phases 2 and 3.
- A refund workflow with earning adjustments (clawback lines).
