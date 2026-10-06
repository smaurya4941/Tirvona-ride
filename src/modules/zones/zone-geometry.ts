import type { GeoCoordinates } from "../locations/geo";

/** GeoJSON Polygon as MongoDB stores it: one closed ring of [lng, lat]. */
export interface GeoJsonPolygon {
  type: "Polygon";
  coordinates: Array<Array<[number, number]>>;
}

export const MIN_ZONE_VERTICES = 3;
export const MAX_ZONE_VERTICES = 500;

export class ZoneGeometryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZoneGeometryError";
  }
}

const samePoint = (a: GeoCoordinates, b: GeoCoordinates): boolean =>
  Math.abs(a.latitude - b.latitude) < 1e-9 &&
  Math.abs(a.longitude - b.longitude) < 1e-9;

/** Orientation of the triplet (p, q, r): 0 collinear, 1 clockwise, 2 counter-clockwise. */
function orientation(
  p: GeoCoordinates,
  q: GeoCoordinates,
  r: GeoCoordinates,
): number {
  const value =
    (q.latitude - p.latitude) * (r.longitude - q.longitude) -
    (q.longitude - p.longitude) * (r.latitude - q.latitude);
  if (Math.abs(value) < 1e-15) return 0;
  return value > 0 ? 1 : 2;
}

function segmentsIntersect(
  p1: GeoCoordinates,
  q1: GeoCoordinates,
  p2: GeoCoordinates,
  q2: GeoCoordinates,
): boolean {
  const o1 = orientation(p1, q1, p2);
  const o2 = orientation(p1, q1, q2);
  const o3 = orientation(p2, q2, p1);
  const o4 = orientation(p2, q2, q1);
  return o1 !== o2 && o3 !== o4;
}

/** Shoelace area in squared degrees — only used to reject degenerate rings. */
function signedArea(points: GeoCoordinates[]): number {
  let sum = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    sum +=
      current.longitude * next.latitude - next.longitude * current.latitude;
  }
  return sum / 2;
}

/**
 * Turns the admin's vertex list into a valid GeoJSON polygon, or explains
 * why it cannot. Accepts an open or already-closed ring; drops consecutive
 * duplicates; rejects fewer than 3 distinct vertices, zero area, and
 * self-intersecting outlines (MongoDB's 2dsphere index would reject those
 * with an opaque error).
 */
export function polygonFromPoints(input: GeoCoordinates[]): GeoJsonPolygon {
  const points: GeoCoordinates[] = [];
  for (const point of input) {
    if (
      !Number.isFinite(point.latitude) ||
      !Number.isFinite(point.longitude) ||
      Math.abs(point.latitude) > 90 ||
      Math.abs(point.longitude) > 180
    )
      throw new ZoneGeometryError(
        "Every boundary point needs a valid latitude and longitude",
      );
    if (points.length === 0 || !samePoint(points[points.length - 1], point))
      points.push(point);
  }
  if (points.length > 1 && samePoint(points[0], points[points.length - 1]))
    points.pop();

  if (points.length < MIN_ZONE_VERTICES)
    throw new ZoneGeometryError(
      `A zone boundary needs at least ${MIN_ZONE_VERTICES} distinct points`,
    );
  if (points.length > MAX_ZONE_VERTICES)
    throw new ZoneGeometryError(
      `A zone boundary can have at most ${MAX_ZONE_VERTICES} points`,
    );

  const count = points.length;
  for (let i = 0; i < count; i += 1) {
    for (let j = i + 1; j < count; j += 1) {
      // Adjacent edges share a vertex; that is not a crossing.
      if (j === i + 1 || (i === 0 && j === count - 1)) continue;
      if (
        segmentsIntersect(
          points[i],
          points[(i + 1) % count],
          points[j],
          points[(j + 1) % count],
        )
      )
        throw new ZoneGeometryError(
          "The zone boundary crosses itself — reorder the points around the edge",
        );
    }
  }

  if (Math.abs(signedArea(points)) < 1e-10)
    throw new ZoneGeometryError("The zone boundary encloses no area");

  const ring = points.map((point): [number, number] => [
    point.longitude,
    point.latitude,
  ]);
  ring.push([points[0].longitude, points[0].latitude]);
  return { type: "Polygon", coordinates: [ring] };
}

export const pointsFromPolygon = (polygon: GeoJsonPolygon): GeoCoordinates[] =>
  polygon.coordinates[0]
    .slice(0, -1)
    .map(([longitude, latitude]) => ({ latitude, longitude }));

/**
 * A regular polygon approximating a circle — the quickest way for an
 * operator to define "10 km around Vrindavan" without a map.
 */
export function circlePoints(
  center: GeoCoordinates,
  radiusKm: number,
  vertices = 48,
): GeoCoordinates[] {
  const latitudeKm = 110.574;
  const longitudeKm = 111.32 * Math.cos((center.latitude * Math.PI) / 180);
  return Array.from({ length: vertices }, (_, index) => {
    const angle = (2 * Math.PI * index) / vertices;
    return {
      latitude:
        Math.round(
          (center.latitude + (radiusKm * Math.sin(angle)) / latitudeKm) * 1e6,
        ) / 1e6,
      longitude:
        Math.round(
          (center.longitude + (radiusKm * Math.cos(angle)) / longitudeKm) * 1e6,
        ) / 1e6,
    };
  });
}
