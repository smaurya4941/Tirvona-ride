# Driver self-service after approval

This covers what an approved driver can see and change once onboarding is done: their licence and personal details, their vehicle, their documents and their individual ratings. It also covers the admin review that applies verified changes.

Code locations:

- **API:** `src/modules/driver-changes` (change requests), `src/modules/drivers` (address), `src/modules/ratings` (reviews list).
- **App:** `lib/features/driver/account/`, reached from the driver Profile tab.
- **Admin:** `src/features/driver-changes/` (Operations → Driver updates) and a pending-updates notice on the driver page.

Tests:

- **API e2e:** `test/driver-self-service.e2e-spec.ts`.
- **App:** `test/features/driver/driver_account_test.dart`.

## The rule: verified details change only through review

Before approval, a driver edits everything directly during onboarding (`PATCH /drivers/me`, `/vehicles`, `/drivers/me/documents`), and submitting KYC locks it. After approval (`APPROVED`, and also `SUSPENDED` so a suspended driver can renew documents), the rules are:

| What | How it changes |
| --- | --- |
| Home address | Directly, `PATCH /drivers/me { address }`. No review. |
| Licence number, licence expiry, date of birth | Change request, then admin review. `PATCH /drivers/me` with these fields returns 400 `DRIVER_CHANGE_REVIEW_REQUIRED`. |
| Vehicle type, registration, make, model, colour, year | Change request, then admin review. |
| Driver documents (licence, Aadhaar, photo, PAN, address proof) | Upload request, then admin review. |
| Vehicle documents (RC, insurance, permit, PUC) | Upload request, then admin review. |

Until an admin approves, the live profile, vehicle and documents stay exactly as verified, so **the driver keeps driving**. Approval applies the change. Rejection leaves everything as it was and tells the driver why.

## API

```
GET    /drivers/me/change-requests             → { pending: [...], history: [...] }  (history = last 30 decided/withdrawn)
POST   /drivers/me/change-requests/profile     { licenseNumber?, licenseExpiry?, dateOfBirth? }
POST   /drivers/me/change-requests/vehicle     { vehicleId, vehicleType?, registrationNumber?, make?, model?, color?, manufactureYear? }
POST   /drivers/me/change-requests/document    multipart: scope=DRIVER|VEHICLE, documentType, vehicleId (VEHICLE), documentNumber?, expiryDate?, file
GET    /drivers/me/change-requests/:id/file    the upload (pending or approved)
DELETE /drivers/me/change-requests/:id         withdraw (pending only; 409 DRIVER_CHANGE_NOT_PENDING otherwise)

GET    /admin/driver-change-requests?status=PENDING|APPROVED|REJECTED|WITHDRAWN&driverId=&page=&limit=
GET    /admin/driver-change-requests/summary   → { pending }
GET    /admin/driver-change-requests/:id       with driver name/code/phone/status
GET    /admin/driver-change-requests/:id/file
POST   /admin/driver-change-requests/:id/approve
POST   /admin/driver-change-requests/:id/reject { reason }   (3–500 chars, shown to the driver)
```

Each request view carries `id`, `kind`, `label` (for example "Driving licence" or "Vehicle details"), `status`, `changes`, `previous`, `hasFile`, `reviewNote`, `submittedAt` and `reviewedAt`.

### Submitting a request

- **Only real changes are stored.** Fields equal to the verified value are dropped, and `previous` holds what they replace, for the reviewer's comparison and the audit trail. A request that changes nothing returns `DRIVER_CHANGE_EMPTY`.
- **Dates:** a licence or document expiry must be in the future. A date of birth must be in the past and not before 1900.
- **Registration plates** are normalised (spaces removed, upper-cased) and must not be used by any other vehicle. This is checked when the request is sent and again when it is approved.
- **One waiting request per target.** The target is the profile, a vehicle, or one document type. A partial unique index on `(driverId, targetKey)` for `PENDING` enforces this. Sending again replaces the waiting request, deletes its old upload, and moves it to the back of the queue.
- **Uploads:** the same file rules as onboarding apply (JPEG, PNG, WEBP or PDF, up to 5 MB). Files are stored under `uploads/driver-changes/<driverId>/`.

### Approving and rejecting

- **Race-safe approval.** Approval first claims the request (`PENDING` → `APPROVED`), so two admins approving at once apply it only once. It then applies the change:
  - **Profile and vehicle fields** are set on the live record.
  - **Documents:** the upload replaces the document on file, or creates one if none exists. The document is marked `VERIFIED`, with `verifiedBy` and `verifiedAt`, and the old file is deleted.
- **Failed approval.** If applying fails (for example, the plate was taken meanwhile, 409 `VEHICLE_ALREADY_EXISTS`), the claim is released and the request waits again.
- **Rejection** stores the reason and deletes the upload. Nothing uses a rejected file, and it is personal data.
- **Audit and notification.** Both decisions write `driver_change.approve` / `driver_change.reject` to the admin audit log and emit `driver.change_reviewed`. That event sends the driver a `DRIVER_UPDATE_APPROVED` / `DRIVER_UPDATE_REJECTED` notification (push and in-app); tapping it opens Documents in the app.

## Individual ratings

```
GET /drivers/me/ratings/reviews?limit=1–50&cursor=&stars=1–5&withComment=true
→ { items: [{ key, rating, comment?, ratedOn: "YYYY-MM-DD" }], nextCursor }
```

The list is newest first and paginated with a cursor (keyset on `createdAt` and `_id`, which is stable while new ratings arrive).

**Riders stay anonymous.** Each item has only the stars, the comment and the calendar day in `APP_TIME_ZONE`:

- no ride, rider, time of day or rating id;
- `key` is a hash, usable only for rendering lists.

Riders rate honestly only if the driver cannot tell who wrote what. The average and star breakdown are still `GET /drivers/me/ratings`.

## App

On the driver's **Profile** tab, the rating card and the rows below it open these screens (all under `/driver/account/`, open to approved drivers only):

- **Driver details** (`/driver/account/details`):
  - shows the verified licence number, expiry (with expired and expiring-soon states) and date of birth;
  - "Request a change" opens a form that sends only the edited fields;
  - a waiting request shows as a banner with **Withdraw**, and the last rejection shows its reason;
  - the address is edited in place.
- **Vehicle** (`/driver/account/vehicle`): the verified vehicle, a "Request a change" form, and the same waiting and rejection banners.
- **Documents** (`/driver/account/documents`):
  - every driver and vehicle document type, each with its state (Verified, On file, Missing, Not on file), number and expiry;
  - an update waiting for review (with **Withdraw**) or the last rejection;
  - **Add / Update / Replace** opens the upload sheet (number, valid-until date, camera or gallery), and photos are downscaled before upload;
  - a **Recent updates** history at the bottom.
- **Ratings & reviews** (`/driver/account/ratings`): the rating summary, filter chips (All, With comments, 5★ to 1★), and infinite scroll.

## Admin panel

- **Operations → Driver updates** (`/driver-updates`): the review queue, oldest first, with a "was → requested" summary per row. Tabs cover waiting, approved, rejected and withdrawn, and the list can be filtered to one driver.
- **Driver update page** (`/driver-updates/:id`):
  - a field-by-field comparison of what is on file and what was requested;
  - **View current** and **View upload** buttons for documents;
  - **Approve and apply**, and **Reject** with a reason for the driver.
- **Driver detail page:** a notice appears when the driver has updates waiting, with an "Update history" link.
