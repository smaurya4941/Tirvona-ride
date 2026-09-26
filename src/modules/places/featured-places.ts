import type { GeoCoordinates } from "../locations/geo";
import { haversineMeters } from "../locations/geo";
import { bookingAddress, normalizeQuery } from "./place-text";
import type { PlaceSuggestion, ResolvedPlace } from "./places.types";

export interface FeaturedPlace {
  slug: string;
  name: string;
  secondaryText: string;
  latitude: number;
  longitude: number;
  /** Other names riders type: "iskcon", "janmabhoomi", "railway station". */
  aliases: string[];
}

/**
 * Curated Braj landmarks: always searchable (even with no provider or while
 * it is down), shown as "Popular places", and used to name a pin dropped on
 * a temple gate. Coordinates are the main entrance / drop-off point.
 */
export const FEATURED_PLACES: readonly FeaturedPlace[] = [
  {
    slug: "prem-mandir",
    name: "Prem Mandir",
    secondaryText: "Raman Reiti, Vrindavan",
    latitude: 27.5714,
    longitude: 77.6716,
    aliases: ["prem temple"],
  },
  {
    slug: "iskcon-vrindavan",
    name: "ISKCON Vrindavan",
    secondaryText: "Bhaktivedanta Swami Marg, Raman Reiti, Vrindavan",
    latitude: 27.5725,
    longitude: 77.677,
    aliases: ["krishna balaram mandir", "iskcon temple", "hare krishna temple"],
  },
  {
    slug: "banke-bihari",
    name: "Banke Bihari Temple",
    secondaryText: "Bihari Pura, Vrindavan",
    latitude: 27.5806,
    longitude: 77.7006,
    aliases: ["bankey bihari", "bihari ji", "banke bihari mandir"],
  },
  {
    slug: "nidhivan",
    name: "Nidhivan",
    secondaryText: "Gaushala Nagar, Vrindavan",
    latitude: 27.5829,
    longitude: 77.6987,
    aliases: ["nidhi van", "nidhuban"],
  },
  {
    slug: "radha-raman",
    name: "Radha Raman Temple",
    secondaryText: "Seva Kunj, Vrindavan",
    latitude: 27.5818,
    longitude: 77.6969,
    aliases: ["radharaman mandir"],
  },
  {
    slug: "keshi-ghat",
    name: "Keshi Ghat",
    secondaryText: "Yamuna riverfront, Vrindavan",
    latitude: 27.5853,
    longitude: 77.6964,
    aliases: ["keshighat"],
  },
  {
    slug: "krishna-janmabhoomi",
    name: "Shri Krishna Janmabhoomi",
    secondaryText: "Deeg Gate, Mathura",
    latitude: 27.5046,
    longitude: 77.6699,
    aliases: ["janmabhoomi", "janmasthan", "krishna janmasthan"],
  },
  {
    slug: "dwarkadhish-mathura",
    name: "Dwarkadhish Temple",
    secondaryText: "Vishram Bazar, Mathura",
    latitude: 27.4964,
    longitude: 77.6857,
    aliases: ["dwarkadheesh"],
  },
  {
    slug: "vishram-ghat",
    name: "Vishram Ghat",
    secondaryText: "Yamuna riverfront, Mathura",
    latitude: 27.492,
    longitude: 77.6853,
    aliases: ["vishram ghaat"],
  },
  {
    slug: "mathura-junction",
    name: "Mathura Junction",
    secondaryText: "Railway Station, Mathura",
    latitude: 27.4808,
    longitude: 77.6734,
    aliases: ["mathura railway station", "mtj", "mathura station"],
  },
  {
    slug: "govardhan-daan-ghati",
    name: "Govardhan (Daan Ghati)",
    secondaryText: "Daan Ghati Temple, Govardhan",
    latitude: 27.4965,
    longitude: 77.4617,
    aliases: ["daan ghati", "govardhan parikrama", "giriraj ji"],
  },
  {
    slug: "barsana-radha-rani",
    name: "Shri Radha Rani Temple",
    secondaryText: "Bhanugarh Hill, Barsana",
    latitude: 27.6488,
    longitude: 77.3786,
    aliases: ["barsana", "ladli ji temple", "shriji temple"],
  },
  {
    slug: "nandgaon-nand-bhavan",
    name: "Nand Bhavan",
    secondaryText: "Nandishwar Hill, Nandgaon",
    latitude: 27.7179,
    longitude: 77.3847,
    aliases: ["nandgaon", "nand baba temple"],
  },
  {
    slug: "gokul",
    name: "Gokul",
    secondaryText: "Raja Thakur Temple area, Gokul",
    latitude: 27.4394,
    longitude: 77.7213,
    aliases: ["gokul dham"],
  },
];

export const FEATURED_ID_PREFIX = "featured:";

const index = FEATURED_PLACES.map((place) => ({
  place,
  terms: [place.name, ...place.aliases, place.secondaryText].map(normalizeQuery),
}));

export function featuredToSuggestion(place: FeaturedPlace, near?: GeoCoordinates): PlaceSuggestion {
  return {
    id: `${FEATURED_ID_PREFIX}${place.slug}`,
    name: place.name,
    secondaryText: place.secondaryText,
    address: bookingAddress(place.name, place.secondaryText),
    latitude: place.latitude,
    longitude: place.longitude,
    ...(near ? { distanceMeters: Math.round(haversineMeters(near, place)) } : {}),
    featured: true,
  };
}

export function featuredToResolved(place: FeaturedPlace): ResolvedPlace {
  const { id, name, address } = featuredToSuggestion(place);
  return { id, name, address, latitude: place.latitude, longitude: place.longitude };
}

export function findFeatured(id: string): FeaturedPlace | undefined {
  if (!id.startsWith(FEATURED_ID_PREFIX)) return undefined;
  const slug = id.slice(FEATURED_ID_PREFIX.length);
  return FEATURED_PLACES.find((place) => place.slug === slug);
}

/**
 * Curated places whose name, alias or locality matches every word the rider
 * typed (each word as a prefix of some word), best first: name-prefix
 * matches, then others; ties by distance when a position is known.
 */
export function searchFeatured(query: string, near?: GeoCoordinates, limit = 5): PlaceSuggestion[] {
  const words = normalizeQuery(query).split(" ").filter(Boolean);
  if (!words.length) return [];
  const scored: Array<{ place: FeaturedPlace; score: number }> = [];
  for (const { place, terms } of index) {
    const termWords = terms.flatMap((term) => term.split(" "));
    if (!words.every((word) => termWords.some((termWord) => termWord.startsWith(word)))) continue;
    const joined = words.join(" ");
    const score = terms[0].startsWith(joined) ? 0 : terms.slice(1).some((term) => term.startsWith(joined)) ? 1 : 2;
    scored.push({ place, score });
  }
  return scored
    .sort(
      (a, b) =>
        a.score - b.score ||
        (near ? haversineMeters(near, a.place) - haversineMeters(near, b.place) : a.place.name.localeCompare(b.place.name)),
    )
    .slice(0, limit)
    .map(({ place }) => featuredToSuggestion(place, near));
}

/** Popular places, nearest first when the rider's position is known. */
export function popularPlaces(near?: GeoCoordinates, limit = 8): PlaceSuggestion[] {
  const places = [...FEATURED_PLACES];
  if (near) places.sort((a, b) => haversineMeters(near, a) - haversineMeters(near, b));
  return places.slice(0, limit).map((place) => featuredToSuggestion(place, near));
}

/** A curated place within [radiusMeters] of a point (e.g. a pin on a temple gate). */
export function featuredNear(point: GeoCoordinates, radiusMeters: number): FeaturedPlace | undefined {
  let best: { place: FeaturedPlace; meters: number } | undefined;
  for (const place of FEATURED_PLACES) {
    const meters = haversineMeters(point, place);
    if (meters <= radiusMeters && (!best || meters < best.meters)) best = { place, meters };
  }
  return best?.place;
}

/** Whether any curated place lies within [radiusMeters] — i.e. the rider is in Braj. */
export function isNearFeatured(point: GeoCoordinates, radiusMeters: number): boolean {
  return FEATURED_PLACES.some((place) => haversineMeters(point, place) <= radiusMeters);
}
