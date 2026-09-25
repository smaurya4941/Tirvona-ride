# Tirvona Rides — Backend

NestJS API for Tirvona Rides, the pilgrimage-focused ride booking product in the Tirvona ecosystem (bike, auto/e-rickshaw, cab). Serves the Flutter customer/driver app (`tirvona-ride-app`) and the admin panel (`Tirvona_ride_admin`).

## Quick start

```powershell
copy .env.example .env   # fill JWT secrets
npm install
npm run start:dev        # http://localhost:5100/api/v1/health
```

Full setup (MongoDB, Redis, Flutter, admin, Postman): [docs/development/local-setup.md](docs/development/local-setup.md)

## Scripts

| Script | Purpose |
|---|---|
| `npm run start:dev` | Watch mode on port 5100 |
| `npm run build` / `npm run start:prod` | Compile to `dist/` and run it |
| `npm run lint` / `npm run typecheck` | Static checks |
| `npm test` | Unit tests (`src/**/*.spec.ts`) |
| `npm run test:e2e` | HTTP tests against a real MongoDB (`test/*.e2e-spec.ts`) |

## Endpoints (Phase 0)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/health/live` | Liveness — process is up |
| GET | `/api/v1/health` | Readiness — MongoDB and Redis reachable (503 when degraded) |
| GET | `/api/docs` | Swagger UI (disabled in production by default) |

## Structure

See [docs/architecture/overview.md](docs/architecture/overview.md) for the module layout, conventions and the phase-by-phase module plan.
