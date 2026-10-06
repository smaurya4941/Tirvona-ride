# Account deletion and legal pages

Google Play requires every app that lets people create an account to let them
delete it **inside the app** and to publish a **web URL** for the same thing.
Both are here, together with the privacy policy and terms the Play listing and
the app link to.

## API

| Route | Auth | What |
|---|---|---|
| `POST /api/v1/users/me/delete-account` `{ password }` | customer or driver | Deletes the caller's account. Throttled with the `otpVerify` policy (password guessing). |
| `GET /api/v1/legal/privacy` | public | Privacy policy (HTML) |
| `GET /api/v1/legal/terms` | public | Terms of use (HTML) |
| `GET /api/v1/legal/delete-account` | public | How to delete an account, in and out of the app (HTML) |

POST rather than DELETE because some proxies drop a request body on DELETE.
Admin accounts cannot be deleted here (`403 ACCOUNT_DELETION_NOT_ALLOWED`).

### Errors

| Status / code | Meaning |
|---|---|
| 400 `ACCOUNT_DELETION_PASSWORD_INVALID` | wrong password (not 401, so the app does not treat it as an expired session) |
| 409 `ACCOUNT_DELETION_BLOCKED` + `data.reason` | `ACTIVE_RIDE`, `CANCELLATION_FEE_DUE` (customer), `EARNINGS_UNSETTLED` (driver: PENDING/AVAILABLE earnings or an OUTSTANDING clawback). Support settles it, then the person retries. |
| 409 `ACCOUNT_DELETION_IN_PROGRESS` | two deletions raced |
| 403 `ACCOUNT_DELETED` | sign-in or refresh with a deleted account |

## What happens (`AccountDeletionService`)

1. Checks above, then **claims** the account: `status → DELETED`. Every guard
   (access-token check, booking, going online, broadcasts) already refuses a
   non-ACTIVE user, so nothing new can start. The checks run again after the
   claim; if a ride slipped in, the claim is reverted and the call 409s.
2. All sessions revoked, push tokens removed (`auth.sessions_revoked`,
   reason `ACCOUNT_DELETED`).
3. Drivers: document files deleted from disk and their records removed
   (driver documents, vehicle documents, change requests), vehicles
   deactivated with details cleared and the registration number released,
   profile suspended with licence number, birth date, address and location
   erased.
4. Everyone: profile photo, saved places, emergency contacts, notifications,
   push tokens, password-reset / pending-signup / OTP records erased; share
   links revoked; the user row anonymised (`phone = deleted:<id>`, name
   "Deleted user", email/password/DOB/gender/photo unset). The phone number
   is therefore free: the person can sign up again.

**Kept** (no personal data attached to the user row): rides, payments,
refunds, driver earnings/adjustments/payouts, ratings, support tickets, SOS
incidents, audit logs. They are tax/accounting/safety records and the other
person on a trip needs theirs. The privacy policy says "up to 8 years"; add a
retention job if you want them removed after that.

Not touched on purpose: SOS events and support tickets may still contain a
contact's name/number that the person typed. Purge them in a retention job if
your legal advice says so.

## Legal pages

`src/modules/legal/legal-pages.ts`: plain server-rendered HTML, no JavaScript
(passes the helmet CSP), cacheable for an hour. Configured by:

| Env | |
|---|---|
| `LEGAL_ENTITY_NAME` | Company name shown in the text (default `Tirvona`) |
| `SUPPORT_EMAIL` | **Required in production.** Shown as the contact on all three pages |
| `SUPPORT_PHONE` | Optional |

The text describes what the apps really collect (phone, name, precise
location while online, driver documents, emergency contacts, Razorpay,
Firebase, Google Maps, Meta WhatsApp). **It is a working draft. Have it
reviewed by someone qualified before you publish**, and change
`LEGAL_LAST_UPDATED` whenever the wording changes in substance. If you add an
SDK or data type (analytics, Crashlytics, ads), update the policy *and* the Play
Data safety form.

## App

* Settings → **Delete account** (customer and driver). Also reachable from the
  driver registration and pending-approval screens, so a driver who is not yet
  approved can delete too (router allows `/driver/settings/delete-account` in
  every driver state).
* Settings → Privacy policy, Terms of use; the register screen shows
  "By continuing you agree to the Terms of use and Privacy policy".
* URLs come from `AppConfig` (`<API origin>/api/v1/legal/...`), so they follow
  `API_BASE_URL`.

## Tests

`test/account-deletion.e2e-spec.ts` (9 tests: wrong password, erasure,
sessions, number reuse, every block reason, driver erasure, the three pages),
Flutter `test/features/account/delete_account_test.dart`.
