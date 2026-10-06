import type { GeoCoordinates } from "./geo";

/** Google's encoded polyline format (precision 5), as returned by the Routes API. */
export function decodePolyline(encoded: string): GeoCoordinates[] {
  const points: GeoCoordinates[] = [];
  let index = 0;
  let latitude = 0;
  let longitude = 0;
  const readValue = (): number => {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      if (index >= encoded.length) throw new RangeError("Truncated polyline");
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (index < encoded.length) {
    latitude += readValue();
    longitude += readValue();
    points.push({ latitude: latitude / 1e5, longitude: longitude / 1e5 });
  }
  return points;
}

export function encodePolyline(points: readonly GeoCoordinates[]): string {
  let previousLatitude = 0;
  let previousLongitude = 0;
  let output = "";
  const write = (delta: number): void => {
    let value = delta < 0 ? ~(delta << 1) : delta << 1;
    while (value >= 0x20) {
      output += String.fromCharCode((0x20 | (value & 0x1f)) + 63);
      value >>= 5;
    }
    output += String.fromCharCode(value + 63);
  };
  for (const point of points) {
    const latitude = Math.round(point.latitude * 1e5);
    const longitude = Math.round(point.longitude * 1e5);
    write(latitude - previousLatitude);
    write(longitude - previousLongitude);
    previousLatitude = latitude;
    previousLongitude = longitude;
  }
  return output;
}

/**
 * One polyline through several legs. A leg without a road path (straight-line
 * fallback) contributes its two end points, so the joined line is always
 * continuous. Returns undefined when no leg has a road path at all.
 */
export function joinLegs(
  legs: ReadonlyArray<{
    from: GeoCoordinates;
    to: GeoCoordinates;
    polyline?: string;
  }>,
): string | undefined {
  if (!legs.some((leg) => leg.polyline)) return undefined;
  const points: GeoCoordinates[] = [];
  for (const leg of legs) {
    const path = leg.polyline
      ? decodePolyline(leg.polyline)
      : [leg.from, leg.to];
    points.push(...(points.length ? path.slice(1) : path));
  }
  return encodePolyline(points);
}
