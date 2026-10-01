# Login with a WhatsApp code

Customers and drivers can sign in two ways, both on the login screen:

| Method | Endpoint | Cost |
| --- | --- | --- |
| Mobile number + password | `POST /auth/login` (unchanged) | free |
| Mobile number + WhatsApp code | `POST /auth/login/otp/request` → `POST /auth/login/otp/verify` | one paid WhatsApp authentication message per code |

Both end in the **same `AuthSession`** (user + access + refresh token), the
same `user_sessions` row, and the same `lastLoginAt` update. Old app builds
keep using password login; nothing about it changed.

The code machinery is the signup one (see [whatsapp-otp.md](whatsapp-otp.md)):
`OtpService` with purpose **`LOGIN`**, HMAC storage, 5 attempts, expiry,
single use, latest code only, and WhatsApp delivery through `WhatsAppGateway`.
The Meta template (`WHATSAPP_OTP_TEMPLATE_NAME`) only says "X is your
verification code", so the same template serves login. You can rename it to a
neutral name such as `tirvona_ride_otp` by creating that template in Meta and
changing the env var. No code change is needed.

```
Login screen: [ Password | WhatsApp code ]
                 │ WhatsApp code
                 ▼
POST /auth/login/otp/request { phone } ──► LoginOtpService ──► OtpService.issue(LOGIN) ──► WhatsApp
                 │ OtpChallenge (same shape as forgot-password)
                 ▼
/login/verify  (OtpVerificationPanel: 6 boxes, timers, resend = request again)
                 │
POST /auth/login/otp/verify { phone, otp, deviceId… } ──► OtpService.verify(LOGIN) ──► AuthService.completeSignIn
                 ▼
AuthSession ──► router sends customer → home, driver → their screen
```

## API

All paths are under `/api/v1` and are public (listed in the phase-7
public-route audit).

| Method | Path | Body | Success |
| --- | --- | --- | --- |
| POST | `/auth/login/otp/request` | `phone` | 200 `OtpChallenge` |
| POST | `/auth/login/otp/verify` | `phone, otp, deviceId?, deviceType?, deviceName?` | 200 `AuthSession` |

`phone` is normalised like signup (`9876543210`, `098765 43210` and
`+91 98765 43210` all become `+919876543210`).

**Request is also the resend.** Inside the 60 s cooldown it keeps the code
already sent and answers `codeSent: false`, with no second message. After the
cooldown it sends a new code, and every earlier code stops working.

There is **no `verificationId`**. Signup needs one because its form carries a
password that a stranger could attach to your number. A login carries nothing
to hijack, so phone + code is enough.

### Errors

| HTTP | code | When |
| --- | --- | --- |
| 404 | `ACCOUNT_NOT_FOUND` | no customer/driver account uses the number, **or it is an admin**. Nothing is sent; the app offers "Create an account" |
| 403 | `USER_BLOCKED` | blocked account. Checked on request **and again on verify**, before the code is spent |
| 400 | `OTP_INVALID` / `OTP_EXPIRED` / `OTP_TOO_MANY_ATTEMPTS` / `OTP_NOT_ACTIVE` | as for signup |
| 429 | `OTP_RESEND_TOO_SOON` / `OTP_SEND_LIMIT_REACHED` | per-number cooldown / hourly cap (`data.retryAfterSeconds`) |
| 429 | *(no code)* | per-IP throttle: request uses `otpSend`, verify uses `otpVerify` (`THROTTLE_OTP_*`), counted per route |
| 422 | `WHATSAPP_RECIPIENT_UNAVAILABLE` | number not on WhatsApp |
| 503 | `OTP_DELIVERY_FAILED` | Meta failed. The code is withdrawn and the send is not counted |

## Decisions

- **Unknown numbers are told so (Option A).** Signup (`PHONE_ALREADY_REGISTERED`)
  and forgot password (`ACCOUNT_NOT_FOUND`) already reveal whether a number is
  registered. A vague "if this number is registered we sent a code" would hide
  nothing and leave unregistered users waiting. The per-IP and per-number
  limits bound enumeration.
- **Admins stay password-only.** The admin panel has its own login
  (`POST /admin/auth/login`). Admin numbers get the same 404 as unknown
  numbers, and nothing is sent to them.
- **Shared sign-in rules.** `AuthService.assertCanSignIn` (currently: not
  blocked) and `AuthService.completeSignIn` (record login and issue the token
  pair) are used by password login, OTP login and password reset. A future rule
  goes in one place, and every method enforces it.
- **Legacy unverified phones.** An account created before signup OTP with
  `isPhoneVerified: false` is marked verified by a successful code login,
  because receiving the code proves the number. The app then skips the
  separate `/otp` screen.
- **Separate budgets.** Quotas are keyed per `(phone, purpose)`. LOGIN codes
  have their own cooldown and hourly cap, so heavy code logins never block a
  signup or a password reset for the same number, and the reverse holds too.
  A code from one flow never verifies another (the purpose is part of the HMAC
  and of the record key).

## App (Flutter)

- `lib/features/auth/presentation/login_screen.dart`: the `Password | WhatsApp code`
  toggle (`SegmentedButton`). WhatsApp mode hides the password field and
  "Forgot password?" and shows **Send code on WhatsApp**. `ACCOUNT_NOT_FOUND`
  shows **Create an account**. Password mode behaves as before.
- `login_otp_flow.dart`:
  - `LoginOtpFlow` holds the phone and challenge between the two screens.
  - `LoginMethodPreference` remembers the last method chosen on this device
    (`auth.loginMethod` in secure storage).
- `login_otp_screen.dart` (`/login/verify`, a guest route) reuses
  `OtpVerificationPanel` unchanged. On success
  `SessionController.activate` signs in, and the router redirect routes by role.
- `OtpVerificationPanel` now says "We sent you a code a moment ago" instead of
  "New code sent" when a resend returns `codeSent: false` (the server kept
  the earlier code). This applies to every flow that uses the panel.

## Tests

- API: `test/otp-login.e2e-spec.ts`. It covers:
  - request → verify → session (same shape as password login, refresh works,
    device recorded) and drivers;
  - local number formats;
  - unknown/admin/blocked numbers refused with nothing sent, and a block
    after the request wins without spending the code;
  - wrong, expired and locked codes;
  - the cooldown keeps the code, and a resend kills the old code;
  - separate send budget;
  - no cross-flow codes (reset ↔ login, signup → login);
  - parallel verifies (exactly one wins);
  - legacy phone verification;
  - delivery failure is not counted;
  - validation;
  - password login unchanged.
- Public-route audit: `test/phase7.e2e-spec.ts` lists the two new routes.
- App: `test/features/auth/login_otp_test.dart`. It covers:
  - the toggle and its memory;
  - password login still working;
  - send code → code screen → signed in;
  - the sign-up offer for unknown numbers;
  - blocked accounts;
  - an honest resend notice;
  - opening `/login/verify` cold;
  - the redirect matrix for `/login/verify`.

## Cost and rollout

Every code login is a paid WhatsApp authentication message. Password login
costs nothing. The 60 s cooldown, the per-number hourly cap
(`OTP_MAX_SENDS_PER_WINDOW`) and the per-IP `otpSend` throttle limit abuse.
Watch the "Login code sent to …" log line (`LoginOtpService`) for volume.
The change is additive: deploy the API first, then ship the app.
