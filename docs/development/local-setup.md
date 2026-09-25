# Local development setup (Windows)

## 1. Prerequisites

| Tool | Version | Check |
|---|---|---|
| Node.js | 22+ | `node -v` |
| Flutter | 3.47+ | `flutter --version` |
| MongoDB Community Server | 8.x | `mongod --version` |
| Redis-compatible server | 7.x (Phase 3+) | `redis-cli ping` |

### MongoDB

Either option works; the backend defaults to `mongodb://127.0.0.1:27017`, database `tirvona_ride`.

- **Native:** `winget install MongoDB.Server` (installs and starts the `MongoDB` Windows service).
- **Docker:** `docker compose up -d mongodb` from `Tirvona_ride/`.

### Redis

Redis is optional until Phase 3. With `REDIS_URL` empty the API runs and reports Redis as "Not configured".

- **Docker (recommended):** `docker compose up -d redis`.
- **Native Windows:** Redis has no official Windows build. Use [Memurai Developer](https://www.memurai.com/) (Redis-compatible), `winget install Memurai.MemuraiDeveloper`.

## 2. Backend — `tirvona/Tirvona_ride`

```powershell
cd tirvona\Tirvona_ride
copy .env.example .env        # then fill JWT secrets (command is in the file)
npm install
npm run start:dev
```

Verify:

- http://localhost:5100/api/v1/health/live → `{"success":true,...}`
- http://localhost:5100/api/v1/health → MongoDB/Redis status
- http://localhost:5100/api/docs → Swagger

Quality gates: `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:e2e` (needs MongoDB), `npm run build`.

## 3. Admin panel — `tirvona/Tirvona_ride_admin`

```powershell
cd tirvona\Tirvona_ride_admin
npm install
npm run dev                   # http://localhost:5180
```

Vite proxies `/api` to `http://localhost:5100`, so no CORS setup is needed locally.

## 4. Mobile app — `tirvona-ride-app`

```powershell
cd tirvona-ride-app
flutter pub get
flutter run                                                        # Android emulator → 10.0.2.2:5100
flutter run --dart-define=API_BASE_URL=http://192.168.1.110:5100   # physical phone on the same Wi-Fi
```

For a physical phone, use your PC's Wi-Fi IPv4 address from `ipconfig`, and allow inbound TCP 5100 in Windows Firewall
(`New-NetFirewallRule -DisplayName "Tirvona Rides API (dev)" -Direction Inbound -Protocol TCP -LocalPort 5100 -Action Allow -Profile Private`).

The app opens on the **System status** screen, which shows the API, MongoDB and Redis status.

## 5. Postman

Import `docs/api/tirvona-ride.postman_collection.json` and `docs/api/tirvona-ride.local.postman_environment.json`, then select the **Tirvona Rides — Local** environment.

## Phase 0 checklist

- [ ] `GET /api/v1/health` returns `database: "up"`
- [ ] Redis reachable (`redis: "up"`) — or deliberately left unconfigured until Phase 3
- [ ] Flutter app on the emulator shows **Ready** on the System status screen
- [ ] Admin dashboard at http://localhost:5180 shows the System health card as Ready
