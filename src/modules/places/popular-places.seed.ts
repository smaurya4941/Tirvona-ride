import { FEATURED_PLACES } from "./featured-places";

export interface PopularPlaceSeed {
  name: string;
  secondaryText: string;
  city: string;
  latitude: number;
  longitude: number;
  sortOrder: number;
}

/** "Raman Reiti, Vrindavan" → "Vrindavan". */
const cityOf = (secondaryText: string): string =>
  secondaryText.split(",").pop()!.trim();

/**
 * Noida / Delhi NCR — where the app is tested from and the next service
 * area. Coordinates are OpenStreetMap entrances/drop-off points (checked
 * 2026-09-30); admins can move or retire any of them.
 */
const NCR: PopularPlaceSeed[] = [
  {
    name: "Noida City Centre",
    secondaryText: "Sector 32, Noida",
    city: "Noida",
    latitude: 28.5753,
    longitude: 77.3561,
    sortOrder: 10,
  },
  {
    name: "DLF Mall of India",
    secondaryText: "Sector 18, Noida",
    city: "Noida",
    latitude: 28.5674,
    longitude: 77.3211,
    sortOrder: 20,
  },
  {
    name: "ISKCON Temple",
    secondaryText: "Sector 33, Noida",
    city: "Noida",
    latitude: 28.5866,
    longitude: 77.3505,
    sortOrder: 30,
  },
  {
    name: "Worlds of Wonder",
    secondaryText: "Sector 38A, Noida",
    city: "Noida",
    latitude: 28.5649,
    longitude: 77.326,
    sortOrder: 40,
  },
  {
    name: "GIP Mall",
    secondaryText: "Sector 38A, Noida",
    city: "Noida",
    latitude: 28.5675,
    longitude: 77.3259,
    sortOrder: 50,
  },
  {
    name: "Sector 18 Market",
    secondaryText: "Sector 18, Noida",
    city: "Noida",
    latitude: 28.5702,
    longitude: 77.3264,
    sortOrder: 60,
  },
  {
    name: "Botanical Garden Metro",
    secondaryText: "Sector 38, Noida",
    city: "Noida",
    latitude: 28.564,
    longitude: 77.3334,
    sortOrder: 70,
  },
  {
    name: "Amity University",
    secondaryText: "Sector 125, Noida",
    city: "Noida",
    latitude: 28.5432,
    longitude: 77.3327,
    sortOrder: 80,
  },
  {
    name: "Fortis Hospital",
    secondaryText: "Sector 62, Noida",
    city: "Noida",
    latitude: 28.6188,
    longitude: 77.3726,
    sortOrder: 90,
  },
  {
    name: "Akshardham Temple",
    secondaryText: "New Delhi",
    city: "Delhi",
    latitude: 28.6125,
    longitude: 77.2773,
    sortOrder: 100,
  },
  {
    name: "IGI Airport Terminal 3",
    secondaryText: "New Delhi",
    city: "Delhi",
    latitude: 28.5579,
    longitude: 77.0835,
    sortOrder: 110,
  },
];

/** Inserted only into an empty collection (first boot), never re-applied. */
export const POPULAR_PLACE_SEEDS: readonly PopularPlaceSeed[] = [
  ...FEATURED_PLACES.map((place, index) => ({
    name: place.name,
    secondaryText: place.secondaryText,
    city: cityOf(place.secondaryText),
    latitude: place.latitude,
    longitude: place.longitude,
    sortOrder: (index + 1) * 10,
  })),
  ...NCR,
];
