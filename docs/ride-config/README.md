# Ride limits: trip distance and driver radii

Admin-controlled. **MongoDB is the source of truth, the admin panel (Configuration → Ride limits) is the control, the NestJS backend is the runtime authority.** Flutter holds no limits; it shows whatever the API answers. Nothing here is read from `.env`, and a change applies to the very next request on every instance, with no restart and no cache.

## What is configurable

| Setting | Scope | Unit | Default at migration |
|---|---|---|---|
| Minimum trip distance | per ride type | metres | 200 m |
| Maximum trip distance | per ride type | kilometres | 80 km |
| Matching radius | platform | km | 8 km |
| Nearby drivers radius | platform | km | 3 km |

Three different rules, deliberately independent:

- **Trip distance** — how long the requested trip may be. Bike, Auto, Cab (and any ride type an admin adds) each have their own pair.
- **Matching radius** — how far from the pickup dispatch looks for a driver (`MatchingService.findCandidates`). The driver count and pickup ETA on a fare quote use the same value, so a quote never promises drivers dispatch would not consider.
- **Nearby drivers radius** — how far around the rider the Home map draws cars (`GET /rides/nearby-drivers`). Display only; it never limits booking.

Trip distance is judged on the **straight line** between pickup and destination (as before), made before any route is requested so an obviously bad trip never reaches the maps provider. Both ends are inclusive: exactly the minimum, or exactly the maximum, is allowed.

## Data

`ride_distance_configs` — one row per ride type (unique on `rideType`, the ride type code; `rideTypeId` references the ride type):
`rideType`, `rideTypeId`, `minDistanceMeters`, `maxDistanceKm`, `version` (+1 per edit), `updatedBy`, `createdAt`, `updatedAt`.

`platform_settings` — one document (`key: "ride-matching"`, unique): `matchingRadiusKm`, `nearbyDriversRadiusKm`, `version`, `updatedBy`, timestamps.

`rides.distancePolicy` — snapshot written when a ride is booked: `{ rideType, minDistanceMeters, maxDistanceMeters, configId, configVersion }`. Later edits never touch it. Rides booked before this feature have no snapshot.

## Runtime

```
Estimate / Book / Promo preview
  → TripPolicyService.estimateTrip(rideType, pickup, destination)
      → RideDistanceConfigService.getRequired(rideType)   (MongoDB, every call)
      → checkTripDistance(...)                            400 RIDE_TOO_SHORT / RIDE_TOO_LONG
      → route (only if allowed) → pricing → …
Book additionally stores distancePolicy on the ride.

Dispatch      → PlatformSettingsService.matchingRadiusMeters()      → $geoNear maxDistance
Nearby drivers → PlatformSettingsService.nearbyDriversRadiusMeters() → $geoNear maxDistance
```

- `TripPolicyService` is the only place that compares a trip with the limits. Estimate, `estimate/all`, booking and `POST /promotions/validate` all go through it; booking re-reads the limits and ignores any earlier estimate.
- `estimate/all` judges each ride type by its own limits and quotes only those the trip fits (a 15 km trip is quoted for Auto and Cab but not for a Bike capped at 10 km). If no ride type fits it returns the error (`RIDE_TOO_SHORT` / `RIDE_TOO_LONG`).
- `LocationsService` only computes routes; it knows nothing about limits.

### Missing or unusable configuration fails loudly

There is no fallback to hard-coded numbers. A ride type with no row, or a row holding unsound values, answers **503** `RIDE_DISTANCE_CONFIG_MISSING` / `RIDE_DISTANCE_CONFIG_INVALID` (with `data.rideType`) on estimate and booking and is left out of `estimate/all`. Missing or unsound platform settings answer **503** `PLATFORM_SETTINGS_MISSING` / `PLATFORM_SETTINGS_INVALID` for dispatch and the Home map; a fare quote still works (driver supply is decoration) but shows no drivers. The admin panel flags both states and the admin repairs them in place.

## Admin API (`ADMIN` role; audited)

| Route | |
|---|---|
| `GET /admin/ride-distance-config` | every ride type with its limits, `usable` flag and the allowed bounds |
| `GET /admin/ride-distance-config/:rideType` | one ride type |
| `PATCH /admin/ride-distance-config/:rideType` | `{ minDistanceMeters?, maxDistanceKm? }` — an omitted field keeps its value; both are required for a ride type with no row (`RIDE_DISTANCE_CONFIG_INCOMPLETE`) |
| `GET /admin/platform-settings` | the radii and their bounds |
| `PATCH /admin/platform-settings` | `{ matchingRadiusKm?, nearbyDriversRadiusKm? }` |

Validation (server-side, authoritative; the panel mirrors it for UX): numbers only, above zero, minimum whole metres 1–50 000, maximum 0.1–1 000 km (up to 3 decimals), minimum strictly below maximum, matching radius 0.5–100 km, nearby radius 0.1–50 km; unknown fields and `null` are rejected. Each change writes an audit entry (`RIDE_DISTANCE_CONFIG` / `PLATFORM_SETTINGS`) with before and after values and stamps `updatedBy`.

## Ride type lifecycle

A new ride type has no distance limits unless the create request carries `distance: { minDistanceMeters, maxDistanceKm }`. It cannot be created active, or switched on later, without sound limits (`RIDE_TYPE_DISTANCE_REQUIRED`), in addition to the existing tariff requirement. Limits are validated before the ride type is created.

## Migration

On boot, after every module has initialised (`RideConfigMigration`, `onApplicationBootstrap`), each ride type without a row gets 200 m / 80 km and the platform document is created with 8 km / 3 km if absent. These are the values the old environment defaults produced, so upgrading changes no behaviour. It uses `$setOnInsert`, so it is safe to re-run and across several instances, and it never overwrites an admin's edit. The numbers live in `ride-config.limits.ts` (`MIGRATION_DEFAULTS`), are written once and never read at runtime.

The environment variables `RIDE_MIN_DISTANCE_METERS`, `RIDE_MAX_DISTANCE_KM`, `MATCHING_RADIUS_KM` and `NEARBY_DRIVERS_RADIUS_KM` no longer exist; setting them has no effect.

## Admin panel

Configuration → **Ride limits**: a table of ride types (minimum in metres, maximum in km, status, last updated, Edit), an edit dialog with the units beside each input, and a *Ride & matching configuration* card for the two radii. The Ride types page shows each type's limits and takes them when a ride type is created.

## Tests

`src/modules/ride-config/distance-policy.spec.ts` (boundaries, per-type independence, validation) and `test/ride-distance-config.e2e-spec.ts` (migration idempotency, admin validation/security/audit, per-type boundaries, isolation, no-restart changes, booking revalidation and snapshot, matching and nearby radii, new-ride-type lifecycle, missing/invalid configuration).
