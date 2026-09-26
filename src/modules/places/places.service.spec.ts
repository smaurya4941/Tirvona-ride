import type { HttpException } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import { popularPlaces, searchFeatured } from "./featured-places";
import { bookingAddress, clampAddress, normalizeQuery, secondaryLine } from "./place-text";
import type { PlaceSuggestion, ResolvedPlace } from "./places.types";
import { PlacesService } from "./places.service";
import { GeocodingProvider, GeocodingProviderError } from "./providers/geocoding.provider";
import type { ProviderSearchRequest } from "./providers/geocoding.provider";
import { TtlCache } from "./ttl-cache";

const settings: Record<string, unknown> = {
  placesBiasLatitude: 27.5406,
  placesBiasLongitude: 77.6708,
  placesBiasRadiusKm: 50,
  placesFeaturedRadiusKm: 75,
  placesCountryCodes: ["in"],
  placesCacheTtlSeconds: 600,
  placesCacheMaxEntries: 100,
};
const config = {
  getOrThrow: (key: string) => {
    if (!(key in settings)) throw new Error(`missing ${key}`);
    return settings[key];
  },
} as unknown as ConfigService;

const VRINDAVAN = { latitude: 27.5714, longitude: 77.6716 };
/** Sector 62, Noida — ~120 km from Braj, where the app is tested from. */
const NOIDA = { latitude: 28.627, longitude: 77.3727 };

class FakeProvider extends GeocodingProvider {
  readonly name = "fake";
  isConfigured = true;
  searches: ProviderSearchRequest[] = [];
  reverses = 0;
  results: Array<Omit<PlaceSuggestion, "featured">> = [];
  places = new Map<string, ResolvedPlace>();
  reversed: ResolvedPlace | null = null;
  failWith?: Error;

  async autocomplete(request: ProviderSearchRequest) {
    this.searches.push(request);
    if (this.failWith) throw this.failWith;
    await Promise.resolve();
    return this.results;
  }

  async resolve(id: string) {
    if (this.failWith) throw this.failWith;
    return this.places.get(id) ?? null;
  }

  async reverse() {
    this.reverses += 1;
    if (this.failWith) throw this.failWith;
    return this.reversed;
  }
}

const statusOf = async (promise: Promise<unknown>): Promise<{ status: number; code: string }> => {
  try {
    await promise;
  } catch (error) {
    const response = (error as HttpException).getResponse() as { code: string };
    return { status: (error as HttpException).getStatus(), code: response.code };
  }
  throw new Error("expected a rejection");
};

describe("PlacesService", () => {
  let provider: FakeProvider;
  let service: PlacesService;

  beforeEach(() => {
    provider = new FakeProvider();
    service = new PlacesService(provider, config);
  });

  describe("autocomplete", () => {
    it("puts curated matches first, then de-duplicated provider results with distances", async () => {
      provider.results = [
        // Same temple as the curated entry (a few metres off): dropped.
        {
          id: "osm:W1",
          name: "Shri Banke Bihari Mandir",
          secondaryText: "Vrindavan",
          address: "Shri Banke Bihari Mandir, Vrindavan",
          latitude: 27.58062,
          longitude: 77.70058,
        },
        {
          id: "osm:N2",
          name: "Banke Bihari Colony",
          secondaryText: "Mathura",
          address: "Banke Bihari Colony, Mathura",
          latitude: 27.49,
          longitude: 77.67,
          distanceMeters: 1,
        },
      ];
      const result = await service.autocomplete({ query: "Banke Bih", near: VRINDAVAN, limit: 8 });
      expect(result.degraded).toBe(false);
      expect(result.suggestions.map((s) => s.id)).toEqual(["featured:banke-bihari", "osm:N2"]);
      expect(result.suggestions[0]).toMatchObject({ featured: true, name: "Banke Bihari Temple" });
      // Provider distances are replaced by the distance from the rider.
      expect(result.suggestions[1].distanceMeters).toBeGreaterThan(8_000);
      expect(provider.searches[0]).toMatchObject({ query: "Banke Bih", bias: VRINDAVAN, countryCodes: ["in"] });
    });

    it("caches by normalised query and coalesces concurrent identical searches", async () => {
      await Promise.all([
        service.autocomplete({ query: "Govind Dev", limit: 8 }),
        service.autocomplete({ query: "  govind   DEV ", limit: 8 }),
      ]);
      await service.autocomplete({ query: "Govind dev!", limit: 8 });
      expect(provider.searches).toHaveLength(1);
      // Without a rider position the service area centre is the bias.
      expect(provider.searches[0].bias).toEqual({ latitude: 27.5406, longitude: 77.6708 });
    });

    it("falls back to curated places when the provider fails, without caching the failure", async () => {
      provider.failWith = new GeocodingProviderError("Nominatim 503", true);
      const degraded = await service.autocomplete({ query: "iskcon", limit: 8 });
      expect(degraded).toEqual({
        degraded: true,
        suggestions: [expect.objectContaining({ id: "featured:iskcon-vrindavan" })],
      });
      provider.failWith = undefined;
      expect((await service.autocomplete({ query: "iskcon", limit: 8 })).degraded).toBe(false);
      expect(provider.searches).toHaveLength(2);
    });

    it("serves only curated places, flagged degraded, when no provider is configured", async () => {
      provider.isConfigured = false;
      const result = await service.autocomplete({ query: "mathura", limit: 8 });
      expect(result.degraded).toBe(true);
      expect(provider.searches).toHaveLength(0);
      expect(result.suggestions.length).toBeGreaterThan(0);
      expect(result.suggestions.every((s) => s.featured)).toBe(true);
    });

    it("respects the limit", async () => {
      provider.results = Array.from({ length: 10 }, (_, i) => ({
        id: `osm:N${i}`,
        name: `Place ${i}`,
        secondaryText: "Agra",
        address: `Place ${i}, Agra`,
        latitude: 27.1 + i / 100,
        longitude: 78,
      }));
      expect((await service.autocomplete({ query: "place", limit: 4 })).suggestions).toHaveLength(4);
    });
  });

  describe("resolve", () => {
    it("resolves curated ids locally and provider ids through the provider", async () => {
      await expect(service.resolve("featured:prem-mandir")).resolves.toMatchObject({
        name: "Prem Mandir",
        latitude: 27.5714,
      });
      const place = { id: "google:abc1234567", name: "Hotel", address: "Hotel, Vrindavan", latitude: 27.5, longitude: 77.6 };
      provider.places.set(place.id, place);
      await expect(service.resolve(place.id, "session-token")).resolves.toEqual(place);
    });

    it("answers 404 for unknown places and 503 when the provider is down", async () => {
      expect(await statusOf(service.resolve("osm:N404"))).toEqual({ status: 404, code: "PLACE_NOT_FOUND" });
      expect(await statusOf(service.resolve("featured:nowhere"))).toEqual({ status: 404, code: "PLACE_NOT_FOUND" });
      provider.failWith = new GeocodingProviderError("timeout", true);
      expect(await statusOf(service.resolve("osm:N500"))).toEqual({ status: 503, code: "PLACES_UNAVAILABLE" });
    });
  });

  describe("reverse", () => {
    it("names a pin on a curated landmark without asking the provider, keeping the exact pin", async () => {
      const pin = { latitude: 27.57145, longitude: 77.67165 };
      const place = await service.reverse(pin);
      expect(place).toMatchObject({ name: "Prem Mandir", approximate: false, ...pin });
      expect(provider.reverses).toBe(0);
    });

    it("uses the provider's name with the rider's coordinates, cached per ~11 m cell", async () => {
      provider.reversed = {
        id: "osm:W9",
        name: "Gopinath Bazar",
        address: "Gopinath Bazar, Vrindavan",
        latitude: 27.58,
        longitude: 77.69,
      };
      const first = await service.reverse({ latitude: 27.58311, longitude: 77.69411 });
      const second = await service.reverse({ latitude: 27.58312, longitude: 77.69412 });
      expect(first).toMatchObject({ name: "Gopinath Bazar", latitude: 27.58311, longitude: 77.69411, approximate: false });
      expect(second).toMatchObject({ latitude: 27.58312, longitude: 77.69412 });
      expect(provider.reverses).toBe(1);
    });

    it("always answers: a coordinate label when the provider fails or finds nothing", async () => {
      provider.failWith = new Error("socket hang up");
      const place = await service.reverse({ latitude: 27.6, longitude: 77.75 });
      expect(place).toMatchObject({
        name: "Pinned location",
        address: "Pinned location (27.60000, 77.75000)",
        approximate: true,
        latitude: 27.6,
        longitude: 77.75,
      });
      provider.failWith = undefined;
      provider.reversed = null;
      expect((await service.reverse({ latitude: 27.61, longitude: 77.76 })).approximate).toBe(true);
    });
  });

  it("ranks local results ahead of curated Braj matches for a rider far from Braj", async () => {
    provider.results = [
      {
        id: "osm:N9",
        name: "Gokul Dham Society",
        secondaryText: "Sector 62, Noida",
        address: "Gokul Dham Society, Sector 62, Noida",
        latitude: 28.6205,
        longitude: 77.3701,
      },
    ];
    const far = await service.autocomplete({ query: "gokul", near: NOIDA, limit: 5 });
    expect(far.suggestions.map((place) => place.name)).toEqual(["Gokul Dham Society", "Gokul"]);
    expect(provider.searches[0].bias).toEqual(NOIDA);

    const inBraj = await service.autocomplete({ query: "gokul", near: VRINDAVAN, limit: 5 });
    expect(inBraj.suggestions.map((place) => place.name)).toEqual(["Gokul", "Gokul Dham Society"]);
  });

  it("offers no popular Braj places to a rider far from Braj", () => {
    expect(service.popular(NOIDA, 8)).toEqual([]);
    expect(service.popular(undefined, 3)).toHaveLength(3);
  });

  it("lists popular places nearest first", () => {
    const nearMathura = service.popular({ latitude: 27.4808, longitude: 77.6734 }, 3);
    expect(nearMathura[0].name).toBe("Mathura Junction");
    expect(nearMathura).toHaveLength(3);
    expect(nearMathura.every((place) => place.distanceMeters !== undefined)).toBe(true);
  });
});

describe("featured places", () => {
  it("matches names, aliases and word prefixes in any order", () => {
    expect(searchFeatured("bankey")[0]?.id).toBe("featured:banke-bihari");
    expect(searchFeatured("railway station")[0]?.id).toBe("featured:mathura-junction");
    expect(searchFeatured("temple radha").map((p) => p.id)).toContain("featured:radha-raman");
    expect(searchFeatured("xyz")).toEqual([]);
    expect(searchFeatured("   ")).toEqual([]);
  });

  it("gives every curated place a valid bookable address", () => {
    for (const place of popularPlaces(undefined, 100)) {
      expect(place.address.length).toBeGreaterThanOrEqual(2);
      expect(place.address.length).toBeLessThanOrEqual(200);
      expect(place.address.startsWith(place.name)).toBe(true);
    }
  });
});

describe("place text", () => {
  it("normalises queries for matching and cache keys", () => {
    expect(normalizeQuery("  Bānke-Bihārī  Temple!! ")).toBe("banke bihari temple");
  });

  it("builds a short secondary line from a provider address", () => {
    expect(
      secondaryLine("Prem Mandir, Raman Reiti, Vrindavan, Vrindavan, Mathura, Uttar Pradesh, 281121, India", "Prem Mandir"),
    ).toBe("Raman Reiti, Vrindavan, Mathura, Uttar Pradesh");
    // Non-adjacent repeats, and the name restated mid-address (Photon street fields).
    expect(
      secondaryLine("Fortis Hospital, Sector 62, Noida, Fortis Hospital, Sector 62, Noida, Uttar Pradesh", "Fortis Hospital"),
    ).toBe("Sector 62, Noida, Uttar Pradesh");
  });

  it("keeps booking addresses within the ride DTO limit", () => {
    const long = Array.from({ length: 40 }, (_, i) => `Locality ${i}`).join(", ");
    const clamped = clampAddress(long);
    expect(clamped.length).toBeLessThanOrEqual(200);
    expect(clamped.endsWith(",")).toBe(false);
    expect(bookingAddress("Nidhivan", "Nidhivan, Vrindavan")).toBe("Nidhivan, Vrindavan");
    expect(bookingAddress("Nidhivan", "")).toBe("Nidhivan");
  });
});

describe("TtlCache", () => {
  it("expires entries, evicts least-recently-used and never caches failures", async () => {
    let now = 0;
    const cache = new TtlCache<number>(2, () => now);
    cache.set("a", 1, 100);
    cache.set("b", 2, 100);
    expect(cache.get("a")).toBe(1); // "b" is now the oldest
    cache.set("c", 3, 100);
    expect(cache.get("b")).toBeUndefined();
    now = 150;
    expect(cache.get("a")).toBeUndefined();

    await expect(cache.getOrLoad("x", 100, () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(cache.getOrLoad("x", 100, async () => 7)).resolves.toBe(7);
    await expect(cache.getOrLoad("x", 100, async () => 8)).resolves.toBe(7);
  });
});
