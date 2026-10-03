# Rider Home & "Where to?" data

The redesigned rider Home and search screens are backed entirely by the API. None of the lists are hard-coded in the app.

| Screen element | Source | Storage |
| --- | --- | --- |
| Map cars around the pickup | `GET /rides/nearby-drivers?latitude&longitude` (customer) | `driver_profiles` (same eligibility as matching: approved, online, available, fresh GPS) |
| Home / Work shortcuts | `GET /places/saved`, `PUT /places/saved/:kind`, `DELETE /places/saved/:kind` (`home` \| `work`, customer) | `saved_places` (unique per user + kind) |
| Recent destinations | `GET /rides/recent-destinations?limit` (customer), merged in the app with places picked on the device | `rides` (distinct destinations, newest first, 50 m de-dup) |
| Popular destinations (+ photos) | `GET /places/popular?latitude&longitude&limit`; photo `GET /places/popular/:id/image?v=` (public, immutable-cached) | `popular_places` (2dsphere, photo bytes in Mongo) |
| Offers carousel | `GET /promotions` | `promo_codes` |
| Voice search | device speech recogniser (`speech_to_text`, `en_IN`) | — |

## Popular places

- Admin panel: **Configuration → Popular places**. Add, edit, hide, reorder, delete, and upload a photo (landscape PNG/JPEG/WEBP, ≥ 320 × 200, ≤ 1 MB, validated by bytes). Every change is audited (`POPULAR_PLACE`).
- API: `/admin/popular-places` (`GET`, `POST`, `PATCH /:id`, `DELETE /:id`, `PUT|DELETE /:id/image`).
- Riders get active places within `PLACES_FEATURED_RADIUS_KM` (default 75 km), nearest first. A rider far from every place gets an empty list, and the apps hide the section.
- First boot seeds the Braj landmarks plus 11 Noida/Delhi places (OpenStreetMap coordinates, `popular-places.seed.ts`). Seeding runs only on an empty collection, so admin deletions stay deleted.
- Typed search (autocomplete) still uses the static curated Braj list plus the geocoding provider. Admin-added places are not added to typed search; the provider finds them by name.

## Nearby drivers

Positions are rounded to 3 decimals (~110 m) and carry no ids, names or plates. The radius is an admin setting (Configuration → Ride limits, see `docs/ride-config/README.md`) and `NEARBY_DRIVERS_LIMIT` (default 12) caps the count. The route is throttled to 30 requests/min. The app refreshes every 30 s while Home is visible.

## App notes

- Home/Work used to be device-only (added with the redesign). On first launch the app uploads any device copy the server lacks, then deletes it.
- Removing a recent destination (long press) also hides the matching ride-history entry on that device (`places.recent.hidden.<userId>`).
- "Add address" on Home/Work opens the search screen in save mode (`/customer/book/where?field=destination&saveAs=home`).
- Android needs `RECORD_AUDIO` and the `RecognitionService` query (both in the manifest) for voice search.

## Tests

- API: `test/home-search.e2e-spec.ts` (popular places + photos + admin auth/audit, saved places, recent destinations, nearby drivers); `places.e2e-spec.ts` and the phase-7 public-route audit were updated.
- App: `test/features/places/location_search_screen_test.dart`, `test/features/rides/customer_home_tab_test.dart`.

## Choose a ride (booking)

After both ends are set (search, map pin, a saved place or a popular place), the app opens **Choose a ride** (`/customer/book/options`). It replaces the old Ride options → Fare estimate → Confirm booking screens.

- The map shows the route (`routePolyline` of the quote), with a blue pickup and a red destination marker.
- The trip card lets the rider tap either end (back to "Where to?" for that end), swap (re-quotes, keeps the chosen ride type) or change. It also shows distance • time.
- Ride rows come from `POST /rides/estimate/all`: fare, trip time and distance, the fare breakdown (ⓘ) and how soon a driver could arrive. Each quote now carries:
  - `pickupEtaSeconds`: the nearest free driver of the ride type's vehicle type within the admin-set matching radius, straight line × 1.3 at `ROUTE_AVERAGE_SPEED_KMPH`, rounded to whole minutes, at least 1 minute. It is `null` when there is none; the app then shows "No drivers nearby right now" and booking still works, because dispatch keeps searching.
  - `driversNearby`: the count of those drivers.
  - A supply lookup failure never fails the quote.
- The promo code row lives on this screen too; a promo is re-validated on booking.
- **Confirm Ride** calls `POST /rides`: the server re-prices and dispatches to the nearest drivers, and the app opens live tracking. `RIDE_ALREADY_ACTIVE` opens that ride; a `PROMO_*` error drops the promo and explains why.

Tests: `test/features/rides/ride_options_screen_test.dart` (app) and the supply assertions in `test/home-search.e2e-spec.ts` (API).
