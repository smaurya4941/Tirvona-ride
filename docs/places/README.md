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
MapLocationPicker ────┼─ PlacesRepository ──► GET /api/v1/places/autocomplete ─► Photon → Nominatim (OSM, free)
Home (locate me) ─────┘                       GET /api/v1/places/resolve        or Google Places (New)
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
| `GET /places/popular?latitude=&longitude=&limit=` | Curated places, nearest first. Empty for a rider more than `PLACES_FEATURED_RADIUS_KM` from every curated place (the app then hides the section). | default |

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
| `osm` | **Default, free, no key.** [Photon](https://github.com/komoot/photon) for autocomplete and reverse geocoding, with Nominatim as the fallback when Photon fails (and for resolving `osm:` ids and naming a spot Photon cannot). Photon matches word prefixes ("noida sec" → Noida Sector 18, 62…) and ranks around the rider (zoom 12 bias, tuned with Noida and Vrindavan queries). Uses the public `photon.komoot.io` (fair use, calls spaced `PHOTON_MIN_INTERVAL_MS` apart) unless `PHOTON_BASE_URL` points elsewhere. |
| `photon` | Photon alone. |
| `nominatim` | OpenStreetMap, Nominatim alone. Free. Matches whole words only, so it is a poor fit for a search box. The public server allows about 1 request per second for the whole application. The API spaces calls `NOMINATIM_MIN_INTERVAL_MS` apart and refuses (the search then degrades) instead of queueing riders. Set `NOMINATIM_CONTACT_EMAIL`. For real traffic, self-host and point `NOMINATIM_BASE_URL` at it with `NOMINATIM_MIN_INTERVAL_MS=0`. |
| `none` | Only curated places are searchable. Reverse geocoding returns coordinate labels. |

The default is `google` when `GOOGLE_MAPS_API_KEY` is set, otherwise `osm`.

**Production without Google:** the public Photon and Nominatim servers are
shared, best-effort services. Before real traffic, self-host Photon on one
small VM (a recent Java runtime, per the Photon README; a few GB of disk
for the India index):

```
# Official jar and ready-made India index (keep the two versions compatible:
# see the Photon release notes).
wget https://github.com/komoot/photon/releases/download/1.3.0/photon-1.3.0.jar
wget https://download1.graphhopper.com/public/extracts/by-country-code/in/photon-db-in-latest.tar.bz2
tar -xjf photon-db-in-latest.tar.bz2    # the index, next to the jar
java -jar photon-1.3.0.jar              # serves on port 2322
```

Keep port 2322 private to the API server, then set
`PHOTON_BASE_URL=http://<host>:2322` and `PHOTON_MIN_INTERVAL_MS=0`. Keep `NOMINATIM_CONTACT_EMAIL` set for the fallback.

### Riders outside Braj (testing from Noida)

Search works anywhere in `PLACES_COUNTRY_CODES` and is ranked around the
rider's GPS position (sent as `latitude`/`longitude`). When the rider is
farther than `PLACES_FEATURED_RADIUS_KM` (default 75) from every curated Braj
landmark, local results come before curated matches and `popular` is empty.
Rides can be estimated and booked anywhere; only drivers near the pickup are
matched, so test with a driver account online near the customer.

All settings, with comments, are in `.env.example` under "Place search":
`PLACES_COUNTRY_CODES`, `PLACES_BIAS_*` (used when the app sends no position;
not a hard boundary), `PLACES_FEATURED_RADIUS_KM`, `PHOTON_*`,
`PLACES_TIMEOUT_MS` and `PLACES_CACHE_*`. The cache is in memory, per API process.

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
  cache, text helpers, the Nominatim, Google and Photon providers against a
  mocked `fetch`, the Photon → Nominatim fallback and request spacing) and
  `src/config/environment.spec.ts`.
- API end-to-end: `test/places.e2e-spec.ts` (auth, validation, curated-first
  ranking, outage fallback, resolve and 404, reverse geocoding, then a fare
  estimate from searched places, and a rider in Noida: no Braj popular list,
  search biased to the rider, local fare estimate).
- App: `test/features/places/` (models, recent places, the debounced search
  controller, the booking controller's location flow, and widget tests of the
  search screen).
