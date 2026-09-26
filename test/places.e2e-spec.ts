import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import type { App } from "supertest/types";
import type { GeoCoordinates } from "../src/modules/locations/geo";
import type { PlaceSuggestion, ResolvedPlace } from "../src/modules/places/places.types";
import { GeocodingProvider, GeocodingProviderError } from "../src/modules/places/providers/geocoding.provider";
import type { ProviderSearchRequest } from "../src/modules/places/providers/geocoding.provider";

/**
 * Place search for the booking flow: typed pickup/destination search,
 * resolving a tapped suggestion, "use current location" (reverse geocoding)
 * and popular places — then booking a fare estimate with the result. The
 * geocoding provider is an in-memory fake with the real contract.
 */

const PASSWORD = "Password@123";
const CUSTOMER_PHONE = "+919850000001";
const DRIVER_PHONE = "+919850000011";

const GOVIND_DEV: ResolvedPlace = {
  id: "google:ChIJ-govind-dev-01",
  name: "Govind Dev Ji Temple",
  address: "Govind Dev Ji Temple, Goda Vihar, Vrindavan",
  latitude: 27.5791,
  longitude: 77.6993,
};

class FakeGeocoder extends GeocodingProvider {
  readonly name = "fake";
  readonly isConfigured = true;
  down = false;
  readonly searches: ProviderSearchRequest[] = [];

  async autocomplete(request: ProviderSearchRequest): Promise<Array<Omit<PlaceSuggestion, "featured">>> {
    this.searches.push(request);
    if (this.down) throw new GeocodingProviderError("fake outage", true);
    if (!/govind/i.test(request.query)) return [];
    return [{ id: GOVIND_DEV.id, name: GOVIND_DEV.name, secondaryText: "Goda Vihar, Vrindavan", address: GOVIND_DEV.address }];
  }

  async resolve(id: string): Promise<ResolvedPlace | null> {
    if (this.down) throw new GeocodingProviderError("fake outage", true);
    return id === GOVIND_DEV.id ? GOVIND_DEV : null;
  }

  async reverse(point: GeoCoordinates): Promise<ResolvedPlace | null> {
    if (this.down) throw new GeocodingProviderError("fake outage", true);
    return { id: "osm:W77", name: "Parikrama Marg", address: "Parikrama Marg, Vrindavan", ...point };
  }
}

describe("Place search (e2e)", () => {
  const originalCwd = process.cwd();
  let workDir: string;
  let mongo: MongoMemoryServer;
  let app: INestApplication<App>;
  const geocoder = new FakeGeocoder();
  let customerToken = "";
  let driverToken = "";

  const api = () => request(app.getHttpServer());
  const asCustomer = () => ({ Authorization: `Bearer ${customerToken}` });

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    workDir = await mkdtemp(join(tmpdir(), "tirvona-ride-places-"));
    process.chdir(workDir);
    Object.assign(process.env, {
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      SWAGGER_ENABLED: "false",
      MONGODB_URI: mongo.getUri(),
      MONGODB_DB_NAME: "tirvona_ride_places",
      REDIS_URL: "",
      THROTTLE_LIMIT: "5000",
      JWT_ACCESS_SECRET: randomBytes(48).toString("base64url"),
      JWT_REFRESH_SECRET: randomBytes(48).toString("base64url"),
      MATCHING_SWEEP_INTERVAL_MS: "0",
      PAYMENT_RECONCILE_INTERVAL_MS: "0",
      PLACES_PROVIDER: "osm",
    });

    const { AppModule } = await import("../src/app.module");
    const { configureApp } = await import("../src/app.setup");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(GeocodingProvider)
      .useValue(geocoder)
      .compile();
    app = moduleRef.createNestApplication({ logger: false, rawBody: true });
    configureApp(app);
    await app.init();

    const { UsersService } = await import("../src/modules/users/users.service");
    const { UserRole } = await import("../src/common/types/user-role.enum");
    const users = app.get(UsersService, { strict: false });
    await users.create({ phone: CUSTOMER_PHONE, password: PASSWORD, role: UserRole.CUSTOMER, firstName: "Radha" });
    await users.create({ phone: DRIVER_PHONE, password: PASSWORD, role: UserRole.DRIVER, firstName: "Mohan" });
    const login = async (phone: string) =>
      (await api().post("/api/v1/auth/login").send({ phone, password: PASSWORD, deviceId: `device-${phone}` }).expect(200))
        .body.data.accessToken as string;
    customerToken = await login(CUSTOMER_PHONE);
    driverToken = await login(DRIVER_PHONE);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
    process.chdir(originalCwd);
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  it("requires a signed-in customer or driver", async () => {
    await api().get("/api/v1/places/autocomplete?q=prem").expect(401);
    await api().get("/api/v1/places/popular").set({ Authorization: `Bearer ${driverToken}` }).expect(200);
  });

  it("validates queries", async () => {
    await api().get("/api/v1/places/autocomplete").set(asCustomer()).expect(400);
    await api().get(`/api/v1/places/autocomplete?q=${"x".repeat(101)}`).set(asCustomer()).expect(400);
    await api().get("/api/v1/places/autocomplete?q=prem&latitude=27.5").set(asCustomer()).expect(400);
    await api().get("/api/v1/places/autocomplete?q=prem&sessionToken=bad token").set(asCustomer()).expect(400);
    await api().get("/api/v1/places/reverse?latitude=91&longitude=77").set(asCustomer()).expect(400);
    await api().get("/api/v1/places/resolve?id=http://evil.test").set(asCustomer()).expect(400);
  });

  it("autocompletes: curated landmarks first, then provider results, ranked around the rider", async () => {
    const response = await api()
      .get("/api/v1/places/autocomplete")
      .query({ q: "govind", latitude: 27.5714, longitude: 77.6716, sessionToken: "sess-12345678" })
      .set(asCustomer())
      .expect(200);
    expect(response.body.data).toEqual({
      degraded: false,
      suggestions: [
        {
          id: GOVIND_DEV.id,
          name: GOVIND_DEV.name,
          secondaryText: "Goda Vihar, Vrindavan",
          address: GOVIND_DEV.address,
          featured: false,
        },
      ],
    });
    expect(geocoder.searches.at(-1)).toMatchObject({
      bias: { latitude: 27.5714, longitude: 77.6716 },
      sessionToken: "sess-12345678",
    });

    const curated = (
      await api().get("/api/v1/places/autocomplete").query({ q: "Prem Mand" }).set(asCustomer()).expect(200)
    ).body.data;
    expect(curated.suggestions[0]).toMatchObject({
      id: "featured:prem-mandir",
      featured: true,
      latitude: 27.5714,
      longitude: 77.6716,
    });
  });

  it("degrades to curated places when the provider is down", async () => {
    geocoder.down = true;
    try {
      const body = (await api().get("/api/v1/places/autocomplete?q=janmabhoomi").set(asCustomer()).expect(200)).body.data;
      expect(body.degraded).toBe(true);
      expect(body.suggestions[0].id).toBe("featured:krishna-janmabhoomi");
      const pin = (
        await api().get("/api/v1/places/reverse?latitude=27.6&longitude=77.75").set(asCustomer()).expect(200)
      ).body.data;
      expect(pin).toMatchObject({ approximate: true, latitude: 27.6, longitude: 77.75 });
      const failed = await api().get(`/api/v1/places/resolve?id=${GOVIND_DEV.id}-x`).set(asCustomer()).expect(503);
      expect(failed.body.code).toBe("PLACES_UNAVAILABLE");
    } finally {
      geocoder.down = false;
    }
  });

  it("resolves a tapped suggestion, and 404s an unknown one", async () => {
    const resolved = (
      await api().get("/api/v1/places/resolve").query({ id: GOVIND_DEV.id }).set(asCustomer()).expect(200)
    ).body.data;
    expect(resolved).toEqual(GOVIND_DEV);
    const missing = await api().get("/api/v1/places/resolve?id=osm:N404").set(asCustomer()).expect(404);
    expect(missing.body.code).toBe("PLACE_NOT_FOUND");
  });

  it("names the rider's current location and books a fare estimate from searched places", async () => {
    const here = (
      await api().get("/api/v1/places/reverse?latitude=27.58311&longitude=77.69411").set(asCustomer()).expect(200)
    ).body.data;
    expect(here).toEqual({
      id: "osm:W77",
      name: "Parikrama Marg",
      address: "Parikrama Marg, Vrindavan",
      latitude: 27.58311,
      longitude: 77.69411,
      approximate: false,
    });

    const [popular] = (
      await api().get("/api/v1/places/popular?latitude=27.4808&longitude=77.6734&limit=1").set(asCustomer()).expect(200)
    ).body.data;
    expect(popular.name).toBe("Mathura Junction");

    const pick = ({ address, latitude, longitude }: { address: string; latitude: number; longitude: number }) => ({
      address,
      latitude,
      longitude,
    });
    const estimates = await api()
      .post("/api/v1/rides/estimate/all")
      .set(asCustomer())
      .send({ pickup: pick(here), destination: pick(popular) })
      .expect(200);
    expect(estimates.body.data.length).toBeGreaterThan(0);
  });

  it("serves a rider far from Braj (testing from Noida): no Braj popular list, local fares", async () => {
    const noida = { latitude: 28.627, longitude: 77.3727 };
    const popular = await api().get("/api/v1/places/popular").query({ ...noida, limit: 8 }).set(asCustomer()).expect(200);
    expect(popular.body.data).toEqual([]);

    const search = await api()
      .get("/api/v1/places/autocomplete")
      .query({ q: "govind", ...noida })
      .set(asCustomer())
      .expect(200);
    expect(geocoder.searches.at(-1)?.bias).toEqual(noida);
    expect(search.body.data.degraded).toBe(false);

    const estimates = await api()
      .post("/api/v1/rides/estimate/all")
      .set(asCustomer())
      .send({
        pickup: { address: "Sector 62, Noida", ...noida },
        destination: { address: "Botanical Garden, Noida", latitude: 28.5641, longitude: 77.3342 },
      })
      .expect(200);
    expect(estimates.body.data.length).toBeGreaterThan(0);
  });
});
