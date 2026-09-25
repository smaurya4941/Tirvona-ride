# Place search: typed pickup and destination, and current location

Before this change, customers could only choose from 8 hard-coded test places.
Now they can pick any real location, the same ways Uber and Rapido offer:

- **Type to search** (autocomplete) for either pickup or destination.
- **Use current location** (GPS). When Home opens, the pickup fills itself
  from GPS, and a locate-me button refills it later.
- **Set location on map**: move the map under a fixed pin, then confirm.
- **Recent places** (per user, stored encrypted on the device).
- **Popular in Braj**: a curated list of temples, ghats and stations.

## How it fits together

```
Flutter app                                   API (NestJS)                     Provider
───────────                                   ────────────                     ────────
LocationSearchScreen ─┐
MapLocationPicker ────┼─ PlacesRepository ──► GET /api/v1/places/autocomplete ─► Google Places (New)
Home (locate me) ─────┘                       GET /api/v1/places/resolve        or Nominatim (OSM)
                                              GET /api/v1/places/reverse        or none
                                              GET /api/v1/places/popular  ────► curated list (in code)
```

All provider traffic goes through the API, which gives four benefits:

- The app contains no maps key.
- Every answer is cached. Identical concurrent lookups share one provider call.
- Throttling happens in one place.
- The provider can change (`PLACES_PROVIDER`) without an app release.

Riders still book with plain `{ address, latitude, longitude }`. Ride
validation (`RIDE_TOO_SHORT`, `RIDE_TOO_LONG`) and pricing are unchanged.

## API

All endpoints need a customer or driver bearer token and return the usual
`{ success, data }` envelope.

| Endpoint | Purpose | Throttle |
|---|---|---|
| `GET /places/autocomplete?q=&latitude=&longitude=&sessionToken=&limit=` | Suggestions: curated matches first, then provider results (de-duplicated). `degraded: true` means only curated places were searched. | 90/min |
| `GET /places/resolve?id=&sessionToken=` | Coordinates for a suggestion that came without them (Google). `404 PLACE_NOT_FOUND`, `503 PLACES_UNAVAILABLE`. | 30/min |
| `GET /places/reverse?latitude=&longitude=` | Names the spot at a coordinate (current location, map pin). **Always answers.** When no name is found, `approximate: true` and the address is a coordinate label. The rider's exact coordinates are always kept. | 30/min |
| `GET /places/popular?latitude=&longitude=&limit=` | Curated places, nearest first. | default |

Suggestion ids carry their source as a prefix: `featured:<slug>`, `osm:N123`
or `google:<placeId>`. `resolve` only accepts those prefixes.

### Failure behaviour

When the provider fails, the endpoints degrade instead of failing:

- **Search** falls back to the curated list (`degraded: true`). The app then
  shows a notice and offers "Set location on map".
- **Reverse geocoding** falls back to a coordinate label, so a rider can still
  book from the spot they are standing on.
- **Resolve** returns 503. The app shows the message, and the rider can retry
  or use the map.

Failed provider calls are never cached.

## Providers

| `PLACES_PROVIDER` | Notes |
|---|---|
| `google` | Places API (New) for autocomplete and details, Geocoding API for reverse. Best autocomplete. Needs `GOOGLE_MAPS_API_KEY` with both APIs enabled; restrict the key to the server's IP. The app's session token makes keystrokes plus the final tap one billed session. |
| `nominatim` | OpenStreetMap. Free. The public server allows about 1 request per second for the whole application. The API spaces calls `NOMINATIM_MIN_INTERVAL_MS` apart and refuses (the search then degrades) instead of queueing riders. Set `NOMINATIM_CONTACT_EMAIL`. For real traffic, self-host and point `NOMINATIM_BASE_URL` at it with `NOMINATIM_MIN_INTERVAL_MS=0`. |
| `none` | Only curated places are searchable. Reverse geocoding returns coordinate labels. |

The default is `google` when `GOOGLE_MAPS_API_KEY` is set, otherwise
`nominatim`. **Recommendation for production: `google`.** Nominatim's text
search is not true type-ahead, and the public server's rate limit does not
fit a live ride app.

All settings, with comments, are in `.env.example` under "Place search":
`PLACES_COUNTRY_CODES`, `PLACES_BIAS_*` (results near Vrindavan–Mathura rank
first; this is not a hard boundary), `PLACES_TIMEOUT_MS` and
`PLACES_CACHE_*`. The cache is in memory, per API process.

To add or fix a curated landmark, edit
`src/modules/places/featured-places.ts`. Use the main entrance or drop-off
point as the coordinates, and add the names riders actually type as aliases.

## App behaviour (Flutter, `lib/features/places/`)

- **Home.** The pickup starts empty. The first time Home shows, the app asks
  for location permission once and fills the pickup. If that fails, a hint
  explains why and offers "Open settings" (GPS off or permission permanently
  denied), "Try again" or "Search pickup".
- **Plan your ride** (`/customer/book/where?field=`):
  - Before typing, the list shows current location, set on map, recent places
    and popular places.
  - While typing, results appear after a 300 ms debounce. A newer keystroke
    cancels the older request, and a late answer for an old query is dropped.
  - Choosing one end moves focus to the other. Once both ends are set, the
    app goes straight to ride options.
  - Pickup and destination within 50 m of each other are refused.
  - Long-press a recent place to remove it.
- **Map pin** (`/customer/book/pin?field=`): the address is looked up when the
  map settles, and "Confirm" returns the exact pinned point.
- **Current location** is never saved to recent places. Places the rider
  chooses are saved, up to 8, per user, in the encrypted secure storage.
- The iOS location purpose string now covers customers as well as drivers.

## Tests

- API unit tests: `src/modules/places/**/*.spec.ts` (service, curated search,
  cache, text helpers, both providers against a mocked `fetch`) and
  `src/config/environment.spec.ts`.
- API end-to-end: `test/places.e2e-spec.ts` (auth, validation, curated-first
  ranking, outage fallback, resolve and 404, reverse geocoding, then a fare
  estimate from searched places).
- App: `test/features/places/` (models, recent places, the debounced search
  controller, the booking controller's location flow, and widget tests of the
  search screen).
