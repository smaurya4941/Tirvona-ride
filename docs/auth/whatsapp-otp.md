# Signup OTP over WhatsApp

New customer and driver accounts prove that the user controls their phone by
entering a 6-digit code sent to it on **WhatsApp** (Meta WhatsApp Cloud API),
through the existing Tirvona WhatsApp Business number. NestJS generates,
sends, stores and checks every code. The app only relays `phone + code`.

Scope: this page covers **signup**. The same code machinery also serves
login with a WhatsApp code ([otp-login.md](otp-login.md)) and forgot password
([../account/README.md](../account/README.md)). The ride-start PIN stays
inside the app and never goes over WhatsApp. There is no SMS and no Redis. Expiry cleanup uses MongoDB TTL
indexes.

```
Flutter ──HTTPS──► NestJS AuthModule ──► OtpService ──► WhatsAppGateway ──► Meta Cloud API ──► user's WhatsApp
                        │                    │
                        ▼                    ▼
                 pending_signups     otp_verifications (HMAC, TTL) · otp_send_quotas (TTL)
                        │
                        ▼ verified
                      users (isPhoneVerified: true) → JWT access + refresh
```

`SignupService` decides **when** a code is needed. `OtpService` owns generation,
limits and checking. `WhatsAppGateway` owns **how** it is delivered, and no
Meta-specific code exists outside `src/modules/whatsapp/`.

## Flow

1. **`POST /auth/register`** (202). Validates the form and normalises the phone.
   It refuses a number or email that already has an account. The form is stored
   in `pending_signups` (password already argon2-hashed), then a code is sent on
   WhatsApp. **No user is created.** The response contains a `verificationId`
   but never the code.
2. **`POST /auth/verify-otp`** (200). Takes `phone`, `otp` and `verificationId`
   (plus optional device fields). If the code matches, the user is created with
   `isPhoneVerified: true`, a driver profile (`PENDING`) is added for drivers,
   the code and the pending form are deleted, and an `AuthSession` (user +
   access + refresh token) is returned.
3. **`POST /auth/resend-otp`** (200). Takes `phone` and `verificationId`. It sends
   a new code and every earlier code stops working. The server enforces the
   cooldown and the per-number cap.

Drivers: a verified phone is **not** driver approval. They still go through
KYC, and admin approval sets `driverStatus = APPROVED`.

Accounts created **before** this feature that still have
`isPhoneVerified: false` verify while signed in:
`POST /auth/phone/send-otp` then `POST /auth/phone/verify-otp { otp }`. Both
routes need a bearer token, and the code always goes to the account's own
number. The old public `POST /auth/send-otp` is **removed**, because it let
anyone send codes to any number.

### Why a `verificationId`?

The plan asked for `phone + OTP`. Those alone would allow a takeover. Someone
could submit the form for *your* number with *their* password while you are
signing up. When you then enter the code WhatsApp sent *you*, the account
would be created with their password. Each form submission therefore gets a
fresh random `verificationId`, stored only as a hash. Re-submitting the form
for a number replaces it, and verify/resend require the latest one. The worst
a stranger can do is force you to submit the form again.

## API

All paths are under `/api/v1`. Errors use the standard envelope
`{ success: false, message, code, data? }`. `message` is always safe to show.
Meta's own error details are never returned; they go to the server log only.

| Method | Path | Body | Success |
| --- | --- | --- | --- |
| POST | `/auth/register` | `firstName, lastName?, phone, email?, password, role: CUSTOMER\|DRIVER` | **202** `SignupChallenge` |
| POST | `/auth/verify-otp` | `phone, otp, verificationId, deviceId?, deviceType?, deviceName?` | 200 `AuthSession` |
| POST | `/auth/resend-otp` | `phone, verificationId` | 200 `SignupChallenge` |
| POST | `/auth/phone/send-otp` | (bearer) | 200 `OtpChallenge` |
| POST | `/auth/phone/verify-otp` | (bearer) `otp` | 200 `AuthUser` |

```jsonc
// SignupChallenge (OtpChallenge + verificationId)
{
  "verificationId": "Qm9x…",           // only in signup responses
  "phone": "+919876543210",
  "maskedPhone": "+91 ***** *3210",
  "channel": "WHATSAPP",
  "codeLength": 6,
  "expiresAt": "2026-09-29T10:05:00.000Z",
  "expiresInSeconds": 300,
  "resendAvailableInSeconds": 60,
  "sendsRemaining": 4,
  "codeSent": true                     // false: form re-submitted inside the cooldown, earlier code kept
}
```

`phone` accepts `9876543210`, `98765 43210`, `09876543210`, `919876543210` or
`+91 98765 43210`, and every form is normalised to `+919876543210`. The same
normalisation applies to login, OTP records, the WhatsApp recipient and every
lookup. Indian numbers must be 10-digit mobiles starting 6–9. Other countries
are accepted in E.164.

### Error codes

| HTTP | code | When |
| --- | --- | --- |
| 400 | *(validation)* | bad phone / weak password / `role: ADMIN` / unknown fields such as `isPhoneVerified` |
| 409 | `PHONE_ALREADY_REGISTERED` | number already has an account. Nothing is sent; the app offers "Log in instead" |
| 409 | `EMAIL_ALREADY_REGISTERED` | email used by another account |
| 400 | `OTP_INVALID` | wrong code. `data.attemptsRemaining` |
| 400 | `OTP_EXPIRED` | past `expiresAt` (checked by NestJS, not left to TTL) |
| 400 | `OTP_TOO_MANY_ATTEMPTS` | 5 wrong tries. Only a resend helps |
| 400 | `OTP_NOT_ACTIVE` | code already used, replaced, or never issued |
| 400 | `SIGNUP_SESSION_INVALID` | `verificationId` unknown, expired or replaced. Submit the form again |
| 429 | `OTP_RESEND_TOO_SOON` | inside the 60 s cooldown. `data.retryAfterSeconds` |
| 429 | `OTP_SEND_LIMIT_REACHED` | 5 codes per number per hour used. `data.retryAfterSeconds` |
| 429 | *(no code)* | per-IP throttle (`THROTTLE_SIGNUP_*`, `THROTTLE_OTP_*`) |
| 422 | `WHATSAPP_RECIPIENT_UNAVAILABLE` | Meta says the number can't receive WhatsApp (131026 / test-number allow-list 131030) |
| 503 | `OTP_DELIVERY_FAILED` | Meta unreachable, rate-limited or misconfigured. **The user is never told "sent"** |
| 409 | `PHONE_ALREADY_VERIFIED` | `/auth/phone/send-otp` on a verified account |

## Data

| Collection | Holds | TTL |
| --- | --- | --- |
| `otp_verifications` | `phone, purpose (SIGNUP \| PHONE_VERIFICATION \| RESET_PASSWORD \| LOGIN), otpHash, expiresAt, attempts, verified, createdAt`. One active code per `(phone, purpose)` (unique index) | `expiresAt` (5 min) |
| `otp_send_quotas` | per `(phone, purpose)`: `sendCount, windowStartedAt, lastSentAt, expiresAt`. Kept apart so waiting out a code doesn't reset the budget | end of window (60 min) |
| `pending_signups` | the submitted form: `phone` (unique), `verificationIdHash`, names, email, **argon2** `passwordHash`, role, IP | `expiresAt` (30 min, extended by resends) |

Codes live **only** in `otp_verifications`, never on `users`. The spec's
`otpVerifications` collection uses the existing `otp_verifications` name, in
line with the other snake_case collections. At startup `OtpService` removes
leftover rows from the old one-row-per-send format so the unique index can
build on existing databases.

MongoDB's TTL monitor runs about once a minute, so TTL is **cleanup only**.
`OtpService.verify` always compares `expiresAt` with the current time itself.
A successful verification deletes the code immediately instead of waiting for
TTL.

## Security model

- **HMAC, not a plain hash.** `otpHash = HMAC-SHA256(OTP_HASH_SECRET, "purpose:phone:code")`.
  With only 10⁶ possible codes, an unkeyed SHA-256 can be reversed from a DB
  dump in milliseconds. Binding the phone and purpose means a code cannot
  verify another number or another flow. Comparison uses `timingSafeEqual`.
- **Single use, latest only.** A resend overwrites the hash, so older codes
  die. On success the record is claimed (`verified: true`, conditional
  update), then deleted. Of several parallel requests with the right code,
  exactly one wins.
- **Attempts counted before comparing**, with a conditional `$inc`
  (`attempts < max`), so parallel guessing cannot exceed 5.
- **Limits:** a 60 s cooldown and 5 codes per number per hour (MongoDB, atomic
  conditional updates). Per-IP throttles apply on top: `signup` 10 per 10 min,
  `otpSend` / `otpVerify`. A failed WhatsApp send is refunded, so it doesn't
  consume the cooldown or the budget.
- **No client authority.** `isPhoneVerified` can only become true inside
  `SignupService`. The DTOs reject unknown fields (`forbidNonWhitelisted`).
- **Secrets stay on the server.** The Meta token and phone-number id exist only
  in the API environment. The app talks to NestJS alone.
- **Logging.** Only masked numbers (`+91 ***** *3210`), Meta message ids,
  error codes and `fbtrace_id` are logged. Codes and the token are never
  logged. The one exception is the development-only `log` provider, which
  prints codes; configuration refuses it in production, and it refuses to
  send if it is ever reached there.

## Meta setup (one-time)

1. **WhatsApp Manager → Account tools → Message templates → Create**, category
   **Authentication**:
   - Name `tirvona_signup_otp` (→ `WHATSAPP_OTP_TEMPLATE_NAME`), language
     English (`en` → `WHATSAPP_OTP_TEMPLATE_LANGUAGE`).
   - Code delivery: **Copy code** (keep `WHATSAPP_OTP_TEMPLATE_CODE_BUTTON=true`).
     Meta requires the button parameter, and the gateway sends the code in both
     the body and the button.
   - Tick **"Add security recommendation"** ("For your security, do not share
     this code.") and **"Add expiry time for the code"** = **5 minutes**. This
     must match `OTP_TTL_SECONDS=300`.
   - The resulting message reads roughly: *"123456 is your verification code.
     For your security, do not share this code. This code expires in 5
     minutes."* Authentication templates have fixed wording, and the sender
     shows as the Tirvona business profile. Submit it and wait for
     **Approved**.
2. **API Setup** page of the WhatsApp product in the Meta app: copy the
   **Phone number ID** of the existing Tirvona number
   (→ `WHATSAPP_PHONE_NUMBER_ID`, digits only) and the **WhatsApp Business
   Account ID** (→ `WHATSAPP_BUSINESS_ACCOUNT_ID`).
3. **Business settings → Users → System users**: create or reuse a system
   user. Assign it the WhatsApp account and the app, then **Generate token**
   with `whatsapp_business_messaging` (and `whatsapp_business_management`),
   expiry **Never**. Put the result in `WHATSAPP_ACCESS_TOKEN`. Don't use the
   24-hour temporary token from the API Setup page.
4. Generate `OTP_HASH_SECRET` (48 random bytes, base64url). Changing it later
   only invalidates codes that are in flight.
5. Set `WHATSAPP_API_VERSION` to a Graph API version your app supports.
   `v23.0` is the default; bump it when Meta deprecates it.

A test sender only delivers to numbers on its allow-list (Meta code 131030 →
`WHATSAPP_RECIPIENT_UNAVAILABLE`). The existing production number has no such
limit.

## Configuration

See `.env.example`. Production refuses to start unless `WHATSAPP_PROVIDER=meta`
(implied by setting a token), the phone number id and token are set, and
`OTP_HASH_SECRET` is 32 or more characters.

| Variable | Default | |
| --- | --- | --- |
| `WHATSAPP_PROVIDER` | `meta` if a token is set, else `log` | `log` prints codes (dev only) |
| `WHATSAPP_API_BASE_URL` / `WHATSAPP_API_VERSION` | `https://graph.facebook.com` / `v23.0` | |
| `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_BUSINESS_ACCOUNT_ID`, `WHATSAPP_ACCESS_TOKEN` | — | backend only |
| `WHATSAPP_OTP_TEMPLATE_NAME` / `_LANGUAGE` / `_CODE_BUTTON` | `tirvona_signup_otp` / `en` / `true` | |
| `WHATSAPP_TIMEOUT_MS` | 10000 | one retry on network error / 5xx |
| `OTP_TTL_SECONDS` | 300 | = template expiry |
| `OTP_MAX_ATTEMPTS` | 5 | |
| `OTP_RESEND_COOLDOWN_SECONDS` | 60 | |
| `OTP_MAX_SENDS_PER_WINDOW` / `OTP_SEND_WINDOW_MINUTES` | 5 / 60 | per number |
| `OTP_HASH_SECRET` | dev: falls back to `JWT_ACCESS_SECRET` | required in prod |
| `SIGNUP_PENDING_TTL_MINUTES` | 30 | |
| `THROTTLE_SIGNUP_LIMIT` / `_TTL_MS` | 10 / 600000 | per IP, `POST /auth/register` |

Local development without Meta: leave the token empty. The API logs
`[DEV OTP] >>> 123456 <<< for +91…`.

## App (Flutter)

- `RegisterScreen` calls `SignupFlow.start` and then pushes `/register/verify`
  (a guest route). "Log in instead" appears for `PHONE_ALREADY_REGISTERED`,
  and `EMAIL_ALREADY_REGISTERED` becomes an error on the email field.
- `SignupOtpScreen` / `OtpVerificationPanel` show "Verify your phone · We sent
  a 6-digit code on WhatsApp to +91 98765 43210", six boxes (a single hidden
  field, so paste and one-time-code autofill work), the expiry countdown,
  "Resend available in 42s", attempts left, and a success state. After that
  the router continues by role: customer home, or driver KYC. Countdowns are
  display only. Server answers such as `retryAfterSeconds` override them.
- `SIGNUP_SESSION_INVALID` shows a dialog and returns to the (still filled)
  form.
- `OtpScreen` (`/otp`) is only for older signed-in accounts that are still
  unverified. It uses the `/auth/phone/*` endpoints.
- The app never generates, stores or checks a code.

## Rollout notes

- **Deploy the API and the app together.** Older app builds expect
  `/auth/register` to return tokens and call the removed `/auth/send-otp`, so
  signup fails on them until they update. Login and every other flow are
  unaffected.
- Existing unverified accounts keep working. They are asked to verify on next
  sign-in, as before, now over WhatsApp.

## Tests

```bash
npm test -- src/common/phone src/modules/whatsapp src/config   # normaliser, Meta payload/error mapping/log hygiene, env rules
npm run test:e2e -- test/whatsapp-otp.e2e-spec.ts              # 26 cases: the plan's §30–31 matrix
cd ../../tirvona-ride-app && flutter test test/features/auth test/app/router
```

The e2e suite swaps Meta for an in-memory `WhatsAppGateway` and covers:
normal flow (no account before verify, verified account + session after);
driver lands in KYC; phone normalisation; wrong / expired / exhausted codes;
parallel guessing; resend cooldown, invalidation of the old code and the
per-number cap; duplicate phone (nothing sent) and duplicate email; WhatsApp
failure (never "sent", nothing counted, no orphan records); recipient
unavailable; single use and concurrent redemption; cross-phone codes;
`verificationId` rotation; HMAC-only storage and TTL indexes; client-set
verification flags rejected; the old endpoint gone; legacy-account
verification.

TTL deletion itself is Mongo's job and runs about once a minute. The suite
asserts the TTL indexes exist rather than waiting for them.
