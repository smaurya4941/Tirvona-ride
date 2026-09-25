# Tirvona Rides — Architecture

## Codebases

| Codebase | Location | Stack | Local URL |
|---|---|---|---|
| Backend API | `tirvona/Tirvona_ride` | NestJS 11, Mongoose, Socket.IO | http://localhost:5100/api/v1 · ws `/realtime` |
| Admin panel | `tirvona/Tirvona_ride_admin` | React 19, Vite, Tailwind, React Query | http://localhost:5180 |
| Mobile app (customer + driver) | `tirvona-ride-app` (beside `tirvona-app`) | Flutter, Riverpod, go_router, Dio | emulator → `10.0.2.2:5100` |

Newbackend owns port 5000; Tirvona Rides runs beside it on 5100 so both can run at once.

## Backend conventions

The backend follows the same layered module layout as `Newbackend`:

```
src/
├── main.ts                    # bootstrap only
├── app.module.ts              # config, logger, throttling, infrastructure, feature modules
├── app.setup.ts               # HTTP pipeline (prefix, versioning, CORS, pipes, filters, Swagger) — shared with e2e tests
├── config/                    # environment() loader + validateEnvironment()
├── common/                    # cross-cutting: filters, middleware, http envelope, (guards, decorators from Phase 1)
├── infrastructure/            # database, redis (later: maps, payments, fcm clients)
└── modules/<feature>/
    ├── <feature>.module.ts
    ├── domain/                # enums, state machines, pure business rules, repository interfaces
    ├── application/           # services / use cases
    ├── infrastructure/
    │   └── persistence/       # Mongoose schemas + repository implementations
    └── presentation/
        ├── controllers/       # split by audience: *-customer, *-driver, *-admin controllers
        └── dtos/
```

Rules:

- Controllers never talk to Mongoose; they call application services.
- Business-critical decisions (driver approval, ride transitions, fares, payments, earnings) live only in the backend.
- Every response uses the envelope `{ success: true, data }` or `{ success: false, message, code?, errors?, requestId, timestamp, path }`.
- Every request carries an `X-Request-Id` (client-supplied or generated); it appears in logs and error bodies.
- API routes are versioned: `/api/v1/...`.

## Module plan

| Phase | Backend modules |
|---|---|
| 0 | `health` |
| 1 | `auth`, `users`, `drivers`, `vehicles`, `uploads`, `admin` (auth + driver approval) |
| 2 | `ride-types`, `pricing`, `locations`, `rides`, `matching` |
| 3 | `realtime` (Socket.IO gateway, MongoDB-backed; Redis adapter/presence deferred), driver location in `locations` |
| 4 | `payments`, `earnings` |
| 5 | `ratings`, `notifications`, `safety`, `support` |
| 6 | `places` (temple/stay presets), Tirvona ecosystem integration |
| 7 | `promotions`, `zones`, `reports` |

## Data stores

- **MongoDB** (`tirvona_ride` database) — source of record.
- **Redis** (`tirvona-ride:` key prefix) — *deferred*. Phase 3 deliberately runs without it: MongoDB holds presence and the throttled latest driver location, `DriverLiveLocationStore` keeps high-frequency state in process, and Socket.IO uses its in-memory adapter (single API node). Redis later takes over presence, current location, GEO matching, locks and the Socket.IO adapter without changing the product flow.
