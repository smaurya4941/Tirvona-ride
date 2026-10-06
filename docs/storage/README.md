# File storage (MongoDB GridFS)

KYC documents (driver and vehicle) and profile photos are stored in **MongoDB
GridFS** on the same Atlas cluster as the rest of the data. Nothing is written
to the web server's disk, so a Render redeploy loses nothing. Cloudinary is
**not** configured; the design below is what makes adding it later a one-class
change.

```
Flutter ──JWT + multipart──▶ controller ──▶ DriversService / VehiclesService /
                                            DriverChangesService / ProfileImagesService
                                                         │  (own the metadata + ownership rules)
                                                         ▼
                                                  StorageService          ← the only thing they know
                                                         │  put / open / stream / remove
                                                         ▼
                                              GridFsStorageProvider ──▶ MongoDB Atlas
                                                                          tirvonaFiles.files
                                                                          tirvonaFiles.chunks
```

## Where things live

`src/modules/storage/` (global module; feature modules just inject `StorageService`)

| File | Role |
|---|---|
| `storage.service.ts` | The API everything uses: `put`, `open`, `stream`, `remove`. Validates the **bytes**, picks the provider, owns the reference format. |
| `storage-provider.ts` | The interface a provider implements (`put/open/delete`). |
| `gridfs-storage.provider.ts` | GridFS implementation (`mongoose.mongo.GridFSBucket`, 255 KiB chunks). |
| `document-content.ts` | Magic-byte detection: JPEG, PNG, WEBP, PDF. |
| `legacy-disk-storage.ts` | Read/delete-only for files uploaded before GridFS (`uploads/`). |
| `legacy-uploads-migrator.ts` + `scripts/migrate-uploads-to-gridfs.ts` | `npm run storage:migrate` |

## What MongoDB holds

Metadata stays in the existing collections; the file is only a **reference
string** in the field that used to hold a disk path:

| Collection | Field | Value |
|---|---|---|
| `driver_documents`, `vehicle_documents`, `driver_change_requests` | `filePath` | `gridfs:<24-hex ObjectId>` |
| `profile_images` | `fileRef` | `gridfs:<24-hex ObjectId>` (plus `contentType`, `bytes`, `width`, `height`, `version`) |

GridFS `tirvonaFiles.files` rows carry `metadata`:
`{ module: "drivers|vehicles|driver-changes|profile-images", ownerId, originalName, sha256, contentType }`,
and a random UUID `filename` (never user input).

> **Design note.** The reference is one self-describing string (`<scheme>:<key>`)
> instead of separate `storageProvider` + `fileId` columns. A Cloudinary file is
> simply `cloudinary:<publicId>` in the same field: no schema change, no data
> migration for old rows, and one document can even be GridFS while another is
> Cloudinary during a gradual move. The field keeps its old name `filePath` to
> avoid a rename migration; treat it as "storage reference". It is `select: false`
> where it already was, and the API never returns it.

## Rules enforced (server side)

* Only JPEG, PNG, WEBP, PDF, **decided from the file's first bytes**; a renamed
  HTML/EXE is refused with `400 DOCUMENT_INVALID_TYPE`. Stored `Content-Type`
  is the detected one.
* ≤ 5 MB, one file per request (`413 DOCUMENT_TOO_LARGE`; multer's limit and
  again in `StorageService`). Profile photos additionally keep their own
  size/aspect rules.
* Uploads stay in memory and go straight to GridFS.
* No public URLs. Files are returned only by authenticated routes that check
  ownership first (driver → own documents; `ADMIN` → any; others 403/404).
* Replace order is safe: new file saved → record updated → old file deleted
  (a failure leaves an orphan, never a missing document).
* Account deletion and "remove photo" delete the GridFS files and chunks.

## Endpoints (unchanged for Flutter and the admin panel)

`POST /api/v1/drivers/me/documents`, `GET …/me/documents/:id/file`,
`DELETE …/me/documents/:id`, vehicle and driver-change equivalents,
`GET /api/v1/admin/drivers/:id/documents/:documentId/file`,
`POST/DELETE /api/v1/users/profile-image`, `GET /api/v1/users/me/profile-image`
(ETag + `immutable` caching).

## Configuration

| Env | Default | |
|---|---|---|
| `STORAGE_PROVIDER` | `gridfs` | only `gridfs` exists today |
| `STORAGE_GRIDFS_BUCKET` | `tirvonaFiles` | collections become `<bucket>.files` / `<bucket>.chunks` |

Nothing else: it reuses `MONGODB_URI` / `MONGODB_DB_NAME`. Keep the connection
string only in Render's environment and your local `.env`.

## Moving existing data (once, after deploying this)

```
npm run storage:migrate -- --dry-run   # counts only
npm run storage:migrate
```

Moves `uploads/` files and inline `profile_images.data` photos into GridFS and
rewrites their references; repeatable and safe while the API runs. It must run
where the old `uploads/` folder is. On Render the disk was wiped on each
deploy, so old KYC files are probably gone: the script reports them as
`missing` (exit code 2) and those drivers must upload again. Once it shows
nothing left, `legacy-disk-storage.ts` and `uploads/` can be deleted.

## Atlas / Render checklist

* Atlas **Network Access** must allow Render (Render free/paid egress IPs are
  not fixed: use `0.0.0.0/0` with a strong DB user password, or Render's
  static outbound IPs on a plan that has them).
* Size: a KYC set is ~1–3 MB per driver. Atlas M0 is 512 MB total, so plan for
  an M10+ before real traffic. Backups then include the files.
* GridFS creates its own indexes on first write; no manual index step even with
  `autoIndex` off in production.

## Adding Cloudinary later (not done)

1. New `CloudinaryStorageProvider implements StorageProvider` with
   `scheme = "cloudinary"` (keep the secret on the server only).
2. Register it in `StorageService`'s provider map, add `"cloudinary"` to
   `STORAGE_PROVIDERS`, set `STORAGE_PROVIDER=cloudinary` for new uploads. Old
   `gridfs:` references keep working.
3. Optionally a script that reads each `gridfs:` object, `put`s it and rewrites
   the reference (the legacy migrator is the template).

Controllers, services, schemas, Flutter and the admin panel do not change.

## Tests

`test/storage-gridfs.e2e-spec.ts` (11): GridFS storage and metadata, byte-exact
download, ownership (other driver 404, customer 403, anonymous 401), type by
bytes, size limit, safe replace, delete, photo ETag/replace/remove, inline
legacy photo still served, migration (+ dry run, missing, repeat), account
deletion removes files. `src/modules/storage/document-content.spec.ts`.
`phase1` and `driver-self-service` suites assert GridFS instead of disk.
