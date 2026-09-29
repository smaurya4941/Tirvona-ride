# Branding — logo & splash screen

Admins can replace the **logo** and the **splash screen** shown in the Tirvona Ride
customer/driver app without an app release (Admin panel → Configuration → **Branding**).
With nothing uploaded, every client shows the defaults bundled with it.

## What changes where

| Surface | Source | Admin-changeable? |
| --- | --- | --- |
| App splash screen (Flutter) | admin splash, else `assets/images/splash_art.png` | Yes — from the launch after it was downloaded |
| App logo: sign-in, sign-up, profile footer, payment receipt, admin-account screen | admin logo, else `assets/images/logo.png` | Yes — as soon as it is downloaded |
| Admin panel sidebar, mobile header, login page | admin logo, else `src/assets/logo.png` | Yes |
| Launcher icon, Android 12+ system splash icon, pre-12 launch screen, notification icon, iOS icon/launch image | built into the app (`android/app/src/main/res`, `ios/Runner/Assets.xcassets`) | No — needs an app update |

The operating system draws the launcher icon and native launch screen before any app code
runs, so those can't change at runtime.

## API

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET /api/v1/branding` | public | `{ logo, splash }`; each is `null` (use the default) or `{ kind, path, version, contentType, bytes, width, height, updatedAt }` |
| `GET /api/v1/branding/assets/:kind?v=<version>` | public | Image bytes. `Cache-Control: immutable` (1 year) when `v` matches the current version, otherwise 60 s. Sends an `ETag` and answers `If-None-Match` with 304. Sends `Cross-Origin-Resource-Policy: cross-origin` so the admin panel can show it in an `<img>`. `404 BRANDING_NOT_SET` when no custom image is set |
| `GET /api/v1/admin/branding` | ADMIN | Current branding plus the upload rules per kind |
| `PUT /api/v1/admin/branding/:kind` | ADMIN | Multipart field `file`; replaces the image. Audited as `branding.update` |
| `DELETE /api/v1/admin/branding/:kind` | ADMIN | Back to the app default (idempotent). Audited as `branding.reset` |

`path` is relative to the versioned API base (`/api/v1`). Its `?v=` changes whenever the
image changes, so clients can cache it forever.

The two read routes are public on purpose: the app needs them before sign-in (splash,
sign-in screen). They are listed in the Phase 7 public-route audit
(`test/phase7.e2e-spec.ts`).

### Upload rules

The server checks the image's **bytes** (magic number + header dimensions, `image-probe.ts`),
never the file name or declared MIME type. Only PNG, JPEG and WEBP are accepted, so SVG
(scriptable) is rejected.

| Kind | Max size | Min size | Shape |
| --- | --- | --- | --- |
| `logo` | 1 MB | 400 × 100 px | height ÷ width between 0.25 and 1.5 (landscape or square). A transparent PNG works best; the logo is shown on white and ivory. |
| `splash` | 3 MB | 720 × 1280 px | height ÷ width between 1.6 and 2.4 (portrait phone). 1080 × 2340 recommended. The app fills the screen with it (`cover`), so the edges may be cropped. **Keep the bottom 15 % clear**: the loading indicator is drawn centred at 88 % of the screen height. |

Errors come back as `400 BRANDING_INVALID_IMAGE` with a readable message and `data.hint`.
A file over 3 MB is rejected by multer with 413.

### Storage

Images are stored **in MongoDB** (`brand_assets`, one document per kind, `data` is
`select: false`), not on local disk as KYC documents are. They are small, they survive
redeploys on ephemeral hosts, and every API instance serves the same bytes. `version` is
the first 16 hex characters of the SHA-256 of the bytes.

## Flutter app

`lib/features/branding/`:

- `BrandingCache` keeps the downloaded images and a `manifest.json` under the app-support
  directory. Files are written to `.part` and then renamed. Superseded files are deleted.
- `bootstrap()` reads the cache **before `runApp`**, so the splash can show an admin splash
  from the first frame with no flash of the default.
- `BrandingController` syncs with `GET /branding` once per launch (`brandingSyncProvider`,
  watched by the app shell). It syncs again on resume if the last sync was more than 15
  minutes ago. It only downloads versions it doesn't already have. If the server returns
  `null`, it drops back to the default. Offline or a failed download keeps what is cached.
- It uses its own Dio without the auth interceptor. Branding never triggers a token refresh
  or a sign-out.
- `BrandLogo` is the one widget for the logo everywhere. It falls back to the bundled asset
  if the cached file can't be decoded.
- `SplashScreen` reads the splash once when it opens. A splash downloaded while it is showing
  is used from the next launch, so the screen never swaps images mid-way.

## Admin panel

`src/features/branding/`: `BrandingPage` shows each asset (the logo on white and ivory, the
splash in a phone frame with the loader position marked). Uploads get a local check with the
same rules, then a preview. Nothing is published until **Publish** is pressed.
**Use app default** resets after a confirmation. `BrandLogo` is used in the sidebar, the
mobile header and on the login page.

## Tests

- API unit: `src/modules/branding/image-probe.spec.ts` (PNG/JPEG/WEBP sniffing, rules).
- API e2e: `test/branding.e2e-spec.ts` covers:
  - defaults and 404;
  - admin-only writes;
  - byte-level validation, including SVG disguised as `.png`, and 413;
  - cache headers, ETag/304 and CORP;
  - version change on replace, idempotent reset, and the audit trail.
- Flutter: `test/features/branding/branding_test.dart` covers:
  - cache round-trip, cleanup and a corrupt manifest;
  - sync, reset and offline behaviour;
  - `BrandLogo`;
  - the custom splash layout.
