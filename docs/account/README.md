# Account self-service

This covers forgot password, sign out everywhere, profile edit, change password, profile photo and the rider's own saved places.

Code locations:

- **API:** `src/modules/auth` (password reset, logout-all), `src/modules/users` (profile, password, photo) and `src/modules/places` (saved places).
- **Flutter:** `lib/features/account`, `lib/features/auth/presentation/forgot_password_screens.dart`, `lib/features/places/presentation/saved_places_screen.dart`.

Tests:

- **API e2e:** `test/account.e2e-spec.ts`.
- **Flutter:** `test/features/account/account_test.dart` and `test/features/places/saved_places_screen_test.dart`.

## Forgot password (WhatsApp code)

```
POST /auth/password/forgot      { phone }                 → OtpChallengeView (same shape as sign-up)
POST /auth/password/verify-otp  { phone, otp }            → { resetToken, expiresAt, expiresInSeconds }
POST /auth/password/reset       { resetToken, newPassword, deviceId?, deviceType?, deviceName? } → AuthSession
```

All three routes are public. They are throttled with the `otpSend`, `otpVerify` and `auth` policies.

- **Code storage:** codes use `OtpService` with purpose `RESET_PASSWORD`. The HMAC storage, attempt limit, resend cooldown and per-number send quota are the same as sign-up, but kept separately because the quota is per purpose. Inside the cooldown, `forgot` keeps the code already sent and returns `codeSent: false`.
- **Reset token:** a correct code is consumed and exchanged for a one-time token. Only its SHA-256 is stored in `password_resets`, with one document per user and a TTL. The token lasts `PASSWORD_RESET_TOKEN_TTL_MINUTES` (default 10). A newer verification replaces the older token.
- **Redeeming the token:** `reset` claims the token atomically with `findOneAndDelete`, so it works exactly once. The same request:
  - sets the password and `passwordChangedAt`;
  - marks the phone verified;
  - revokes **every** refresh session of the user;
  - emits `auth.sessions_revoked`, which deactivates the push tokens of the other devices;
  - signs this device in.
- **Rejected before the token is spent:** reusing the current password (`PASSWORD_UNCHANGED`) and a blocked account (`USER_BLOCKED`) are both refused while the token stays valid, so the user can simply try again.
- **Unknown numbers:** `forgot` answers 404 `ACCOUNT_NOT_FOUND`. This is deliberate. `POST /auth/register` already says "this number is registered", so hiding it here would protect nothing and would leave real users waiting for a code that never comes. Admin accounts get the same 404 and are never reset this way (admins are seeded).

App flow: Sign in → "Forgot password?" → `/forgot-password` (number) → `/forgot-password/verify` (the shared `OtpVerificationPanel`) → `/forgot-password/new`. Success activates the session, and the router moves on by role. From **Change password**, "Forgot your current password?" signs the user out and opens the same flow with the number pre-filled.

## Sign out everywhere

`POST /auth/logout-all` requires authentication and returns `{ sessionsEnded }`. It revokes every refresh session, including the caller's, and emits `auth.sessions_revoked`. Access tokens stay valid until they expire, as with the admin block. The app calls it from **Settings → Security**, then signs out locally.

## Profile

`PATCH /users/me` updates only the fields that are sent:

| Field | Rule |
| --- | --- |
| `firstName` | trimmed, 1–60 |
| `lastName` | trimmed, 0–60 (`""` removes it) |
| `email` | lower-cased and unique (409 `EMAIL_ALREADY_REGISTERED`). A new address is stored with `isEmailVerified: false`. `null` or `""` removes it. |
| `gender` | `male` · `female` · `other` |
| `dob` | `YYYY-MM-DD`, in the past, not before 1900 |

The mobile number is the sign-in identity and cannot be changed here.

`PATCH /users/me/password` takes `{ currentPassword, newPassword }`. A wrong current password returns 400 `AUTH_INVALID_CREDENTIALS`, and reusing the current one returns `PASSWORD_UNCHANGED`. The new password must meet the shared policy in `src/common/validation/password.ts` (6–128 characters of any kind, no digit/symbol/case requirement), which sign-up and reset also use. The Flutter copy is in `widgets/password_field.dart`.

## Profile photo

```
POST   /users/profile-image     multipart `file`   → UserSummary (profileImage = "/users/me/profile-image?v=<hash>")
DELETE /users/profile-image                         → UserSummary
GET    /users/me/profile-image                      → the image (private, ETag, 304)
```

- **Validation:** the file is checked by its bytes, never the declared type (`branding/image-probe`). It must be PNG, JPEG or WEBP, at least 128 px, at most 4096 px, with an aspect ratio of 0.5–2 and a size of up to 5 MB. Anything else returns `PROFILE_IMAGE_INVALID`.
- **Storage:** photos are kept in MongoDB in `profile_images`, one per user, like branding and popular-place photos, so there is no file storage to provision.
- **Serving:** the photo is served only to its owner, with `Cache-Control: private, immutable`. A new photo gets a new `v`.
- **App side:** the app downsizes to 1024 px (quality 85) before uploading. It fetches the photo through the authenticated Dio client (`profileImageProvider`, cached per path) and shows initials while none is set.

## Saved places: Home, Work and the rider's own

`GET /places/saved` now returns:

```json
{ "home": {…}|null, "work": {…}|null, "others": [{ "id", "kind": "other", "label", "name", "address", "latitude", "longitude", "updatedAt" }], "othersRemaining": 19 }
```

Every item now carries an `id` and a `label` (`null` for Home and Work). Older apps ignore the new keys.

```
POST   /places/saved/others       { label, address, latitude, longitude, name? }
PATCH  /places/saved/others/:id   { label? } and/or the whole point { address, latitude, longitude, name? }
DELETE /places/saved/others/:id
```

All three return the full `SavedPlacesView`. The `PUT`/`DELETE /places/saved/:kind` routes accept only `home` and `work`.

- **Limits:** a rider can keep up to 20 own places (`SAVED_PLACE_LIMIT_REACHED`).
- **Labels:** 1–40 characters and unique per rider, ignoring case (409 `SAVED_PLACE_DUPLICATE_LABEL`). `home` and `work` are reserved.
- **Isolation:** another rider's id returns 404 `SAVED_PLACE_NOT_FOUND`.

### Schema and migration

Home and Work rows carry `slot` (equal to `kind`), which has a partial unique index on `{ userId, slot }`. Own places use a unique `{ userId, labelKey }` index instead. A filter on `kind` with `$in` would need MongoDB 6+ for partial indexes, so the `slot` field is used instead.

On startup, `SavedPlacesService.onModuleInit` migrates older databases in every environment (production has `autoIndex` off):

1. It backfills `slot` on existing Home and Work rows.
2. It drops the old unique `userId_1_kind_1` index.
3. It creates the new indexes.

The e2e suite covers this migration.

### App

- **Profile → Saved places**, or **Drawer → Saved places**, opens `/customer/saved-places`. From there the rider can:
  - set or change Home and Work;
  - add a place: pick an address in search, then name it (with suggestion chips);
  - rename a place, change its address, or remove it.
- **Address picking:** uses the search screen in pick mode (`AppRoutes.customerPickAddress`, `?mode=pick`). It returns the chosen `Place` and does not touch the trip.
- **"Where to?":** shows the rider's own places under Home and Work as **Your places**, bookable in one tap.

## Settings

Customers use `/customer/settings` and approved drivers use `/driver/settings`. Drivers that are pending or under review have no Settings. The screen has these sections:

- **Account:** edit profile, change password, and saved places (customers only).
- **Notifications and permissions:** the notification centre, plus the live location-permission status, which opens the system app settings.
- **Security:** sign out of all devices.
- **About:** system status and an About dialog.
- **Sign out.**

The profile tab links to Settings and to Edit profile (tap the avatar). The customer drawer's "System Diagnostics" entry is now **Settings**; system status is inside Settings.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PASSWORD_RESET_TOKEN_TTL_MINUTES` | 10 | How long a verified reset code lets the user choose a new password |

The WhatsApp code uses the existing `OTP_*` and `WHATSAPP_*` settings. The Meta authentication template is the same one used for sign-up.
