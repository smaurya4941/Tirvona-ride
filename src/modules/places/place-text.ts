/** LocationPointDto accepts addresses of 2–200 characters. */
export const MAX_ADDRESS_LENGTH = 200;

const collapse = (value: string): string => value.replace(/\s+/g, " ").trim();

/** Trims, collapses whitespace and cuts at a comma boundary when too long. */
export function clampAddress(value: string, max = MAX_ADDRESS_LENGTH): string {
  const text = collapse(value);
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const comma = cut.lastIndexOf(",");
  return (comma > max / 2 ? cut.slice(0, comma) : cut.slice(0, max - 1).trimEnd() + "…").trim();
}

/** Lower-case, accent-free, punctuation-free text for matching and cache keys. */
export function normalizeQuery(value: string): string {
  return collapse(
    value
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " "),
  );
}

/**
 * Splits a provider's one-line address ("Prem Mandir, Raman Reiti,
 * Vrindavan, Mathura, Uttar Pradesh, 281121, India") into the parts a list
 * row shows: drops the leading name, postcodes and the country, and keeps
 * the most specific [maxParts] pieces.
 */
export function secondaryLine(fullAddress: string, name: string, maxParts = 4): string {
  const normalizedName = normalizeQuery(name);
  const parts = fullAddress
    .split(",")
    .map((part) => collapse(part))
    .filter(Boolean)
    .filter((part) => !/^\d{5,6}$/.test(part))
    .filter((part) => !/^(india|bharat)$/i.test(part));
  if (parts.length && normalizeQuery(parts[0]) === normalizedName) parts.shift();
  // Consecutive duplicates ("Mathura, Mathura") are common in OSM data.
  const unique = parts.filter((part, index) => index === 0 || normalizeQuery(part) !== normalizeQuery(parts[index - 1]));
  return clampAddress(unique.slice(0, maxParts).join(", "));
}

/** "Prem Mandir, Raman Reiti, Vrindavan" — name first, then the locality. */
export function bookingAddress(name: string, secondary: string): string {
  if (!secondary) return clampAddress(name);
  if (normalizeQuery(secondary).startsWith(normalizeQuery(name))) return clampAddress(secondary);
  return clampAddress(`${name}, ${secondary}`);
}

/** Label for a spot no provider could name. */
export function coordinateLabel(latitude: number, longitude: number): string {
  return `Pinned location (${latitude.toFixed(5)}, ${longitude.toFixed(5)})`;
}
