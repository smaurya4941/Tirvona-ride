# Passwords, one vehicle, push sounds, live driver map, in-app calls

Tests: `test/live-drivers.e2e-spec.ts`, `src/modules/notifications/push-sound.spec.ts`, Flutter `test/features/account/account_test.dart`.

## 1. Passwords
Any characters, 6 to 128 of them. No digit, symbol or letter-case rule. One policy in `src/common/validation/password.ts` (sign-up, change password, reset password); the Flutter copy is `validateNewPassword` in `widgets/password_field.dart`. Login accepts whatever is stored, so existing accounts are unaffected.

## 2. One vehicle per driver
- `POST /vehicles` returns 409 `DRIVER_VEHICLE_LIMIT` when the driver already has an active vehicle. A partial unique index on `driverId` (where `isActive`) closes the race between two concurrent requests.
- Before approval a driver can still edit the vehicle, or deactivate it and register another.
- After approval the vehicle is locked. A driver who wants a different vehicle (or new details) sends `POST /drivers/me/change-requests/vehicle`, and optionally RC/insurance uploads. Nothing changes until an admin approves it under Driver updates. The driver keeps driving the verified vehicle meanwhile. See `docs/driver-self-service/README.md`.
- Deploying onto data where a driver already has two active vehicles: the index build fails with a logged error and the application check still applies. Deactivate the extra vehicle and restart to get the index.

## 3. Push sounds
Each push carries a bundled sound, chosen by notification type (`pushSoundFor` in `notification-types.ts`):

| Sound | Android channel | Used for |
|---|---|---|
| `ride_request` (triple double-ring, ~4 s) | `tirvona_ride_requests_v2` | a new ride offer for a driver |
| `ride_update` (two-note chime) | `tirvona_rides_v3` | everything else (ride progress, payments, account) |
| `sos_alert` (siren, ~3 s) | `tirvona_sos_v2` | SOS created/updated |

- Android plays the channel's sound and cannot change it once the channel exists on a phone, so the channels are new ids. `MainActivity.kt` creates them at start-up and deletes the old `tirvona_rides` channel. The Dart side (`alert_sounds.dart`) creates the same channels and uses them for notifications shown while the app is open.
- `res/raw/keep.xml` stops the release resource shrinker from deleting the sounds (they are only referenced by name). Without it a release build has no sound at all.
- Files: `android/app/src/main/res/raw/*.wav` and `ios/Runner/*.wav` (registered in the Xcode project). They are synthesised tones; replace the files, keeping the names, to change them.
- iOS plays `<sound>.wav` from the APNs payload; sounds must stay under 30 s.
- `PUSH_ANDROID_CHANNEL_ID` is gone: channel ids are constants shared with the app.
- Phones that still run an older build keep the old channel id and get the default sound until they update. FCM falls back to the manifest default channel (`tirvona_rides_v3`) when a channel does not exist.

## 4. Live driver map (admin)
- `GET /admin/live/drivers`: every approved online driver with name, phone, vehicle, current ride and the best known position. `GET /admin/live/drivers/:id`: one driver of any status. Admin-only, `Cache-Control: no-store`.
- A position is `live` (a fix the API holds in memory) or `saved` (last stored). `fresh` is false after `DRIVER_LOCATION_STALE_SECONDS`; the map fades those pins.
- Panel: **Operations → Live map** (`/live-map`, optional `?driver=<id>`) shows all drivers on a Google map with an Available / On a ride / Busy filter and a side list. **Drivers & KYC → driver** shows a "Live location" map for approved drivers. Both poll every 5 s (paused in hidden tabs).
- Set `VITE_GOOGLE_MAPS_API_KEY` in the admin panel's build environment: a **browser** key with the Maps JavaScript API enabled, restricted to the panel's origin (HTTP referrer). Without it the map area explains what is missing and the lists still work.
- Polling, not sockets: simple, and fine for a panel with a few admins. The in-memory live store is per API node, so on several nodes `fresh` drivers may show as `saved` until the store moves to Redis (see `driver-live-location.store.ts`).

## 5. Calling the other person
- The call button opens the phone's dialer with the number filled in (`tel:`, DIAL intent, no phone permission). One shared widget, `CallIconButton`, on the rider's driver card and the driver's customer card.
- The number is only shared while the driver is committed to the ride (accepted, arrived, started). The API now blanks the driver's phone for the rider before that and after the ride ends, matching what drivers already got for the customer's number.
- Emergency contacts and SOS use the same `callNumber` helper.
