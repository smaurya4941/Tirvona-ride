# Phase 1 — Foundation

Customers and drivers can register and sign in; drivers complete KYC (licence,
vehicle, documents) and submit it; admins approve or reject from the web
panel; approved drivers reach the driver shell.

| Part    | Location                                   | Stack                                  |
| ------- | ------------------------------------------ | -------------------------------------- |
| API     | `tirvona/Tirvona_ride`                     | NestJS 11, Mongoose 9, JWT, Argon2     |
| Mobile  | `tirvona-ride-app`                         | Flutter, Riverpod 3, go_router, Dio    |
| Admin   | `tirvona/Tirvona_ride_admin`               | React 19, Vite, TanStack Query         |

## Run locally

```bash
# API — needs MongoDB on 127.0.0.1:27017 (Redis optional until Phase 3)
cd tirvona/Tirvona_ride
cp .env.example .env            # then set JWT_ACCESS_SECRET / JWT_REFRESH_SECRET
npm install
npm run start:dev               # http://localhost:5100/api/v1, Swagger at /api/docs

# First admin — /auth/register refuses role=ADMIN by design
npm run seed:admin -- +917084110492 "admin123" "Ops Admin"

# Admin panel — http://localhost:5180 (Vite proxies /api to :5100)
cd ../Tirvona_ride_admin && npm install && npm run dev

# Mobile — Android emulator reaches the host API via 10.0.2.2 automatically
cd ../../tirvona-ride-app && flutter pub get && flutter run
# Physical device: flutter run --dart-define=API_BASE_URL=http://<PC-LAN-IP>:5100
```

Dev OTPs are printed to the API log: `[DEV OTP] +9198… (PHONE_VERIFICATION) → 123456`.

## Tests

```bash
cd tirvona/Tirvona_ride
npm test                                        # unit
npm run test:e2e -- test/phase1.e2e-spec.ts     # spec §41 tests A–E, in-memory MongoDB
cd ../../tirvona-ride-app && flutter test       # includes the full routing matrix
```

`test/phase1.e2e-spec.ts` is hermetic (in-memory MongoDB, Redis off, temp
upload dir, generated JWT secrets). The first run downloads a MongoDB binary.

## API

All under `/api/v1`. Every route requires a bearer token unless marked public.

| Method | Path                                             | Access           |
| ------ | ------------------------------------------------ | ---------------- |
| POST   | `/auth/register` · `/auth/login` · `/auth/refresh` · `/auth/logout` | public |
| POST   | `/auth/send-otp` · `/auth/verify-otp`           | public, throttled |
| GET    | `/auth/me`                                       | any role         |
| GET/PATCH | `/users/me` · PATCH `/users/me/password`      | any role         |
| GET/PATCH | `/drivers/me`                                 | DRIVER           |
| GET/POST | `/drivers/me/documents` (multipart `file`)     | DRIVER           |
| DELETE | `/drivers/me/documents/:id`                      | DRIVER           |
| GET    | `/drivers/me/documents/:id/file`                 | DRIVER           |
| POST   | `/drivers/me/submit-kyc`                         | DRIVER           |
| POST/GET | `/vehicles` · `/vehicles/my`                   | DRIVER           |
| GET/PATCH/DELETE | `/vehicles/:id`                        | DRIVER (owner)   |
| GET/POST | `/vehicles/:id/documents` · GET `…/:documentId/file` | DRIVER (owner) |
| GET    | `/admin/dashboard` · `/admin/drivers?status=` · `/admin/drivers/:id` | ADMIN |
| PATCH  | `/admin/drivers/:id/approve` · `/admin/drivers/:id/reject` | ADMIN   |
| GET    | `/admin/drivers/:id/documents/:documentId/file` · `/admin/vehicles/documents/:documentId/file` | ADMIN |

Errors use `{ success: false, message, code, statusCode… }` with the codes in
`src/common/constants/error-codes.ts`.

## Business rules enforced server-side

- **Driver status machine:** `PENDING → UNDER_REVIEW` (driver submits),
  `UNDER_REVIEW → APPROVED | REJECTED` (admin), `REJECTED → UNDER_REVIEW`
  (driver resubmits). Anything else is `400 INVALID_STATUS_TRANSITION`.
- **Submit KYC requires** licence number + expiry, an active vehicle, and
  DRIVING_LICENSE, AADHAAR and PROFILE_PHOTO documents
  (`400 DRIVER_KYC_INCOMPLETE`, with `data` listing what is missing).
- **Submitting locks the application.** Profile, documents and vehicles are
  editable only while `PENDING` or `REJECTED`.
- **Ownership:** driver routes resolve the driver from the JWT, never from a
  client-supplied id; another driver's vehicle or document is a 404.
- **Uploads:** JPEG/PNG/WEBP/PDF only, 5 MB max, random filenames, stored at
  `uploads/drivers/{driverId}/` or `uploads/vehicles/{vehicleId}/`, served only
  through authenticated endpoints. Temp files are removed on any failure.
- **Tokens:** 15-minute access JWT (`sub`, `role` only). Refresh tokens are
  single-use (rotated on every refresh), stored only as SHA-256 hashes in
  `user_sessions`, and revoked on logout.

## Where this differs from the written spec

- **Admin panel is React + Vite**, not Next.js — that was the existing scaffold.
- **`PATCH /drivers/me`** was added: the spec's driver flow has a
  "Driver Registration" step (licence details) with no endpoint to save it.
- **Vehicle document endpoints** were added: §24 requires vehicle documents
  on the admin driver detail page, but §40 had no way to upload them. The
  mobile app does not upload vehicle documents yet.
- **Admins are `users` with `role: ADMIN`** (seeded by script) rather than a
  separate `admin_users` collection, matching the §3 collection list.
- **Phone verification is enforced by the mobile router**, not the API: the
  app sends unverified users to the OTP screen before any shell.
