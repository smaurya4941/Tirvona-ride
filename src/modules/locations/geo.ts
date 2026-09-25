export interface GeoCoordinates {
  latitude: number;
  longitude: number;
}

/** GeoJSON Point as MongoDB stores it: coordinates are [longitude, latitude]. */
export interface GeoJsonPoint {
  type: "Point";
  coordinates: [number, number];
}

const EARTH_RADIUS_METERS = 6_371_008.8;

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

/** Great-circle ("as the crow flies") distance between two points, in metres. */
export function haversineMeters(from: GeoCoordinates, to: GeoCoordinates): number {
  const deltaLatitude = toRadians(to.latitude - from.latitude);
  const deltaLongitude = toRadians(to.longitude - from.longitude);
  const a =
    Math.sin(deltaLatitude / 2) ** 2 +
    Math.cos(toRadians(from.latitude)) *
      Math.cos(toRadians(to.latitude)) *
      Math.sin(deltaLongitude / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(a)));
}

export const toGeoJsonPoint = ({ latitude, longitude }: GeoCoordinates): GeoJsonPoint => ({
  type: "Point",
  coordinates: [longitude, latitude],
});

export const fromGeoJsonPoint = (point: GeoJsonPoint): GeoCoordinates => ({
  latitude: point.coordinates[1],
  longitude: point.coordinates[0],
});
