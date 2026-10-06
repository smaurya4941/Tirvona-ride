import {
  ZoneGeometryError,
  circlePoints,
  pointsFromPolygon,
  polygonFromPoints,
} from "./zone-geometry";

const SQUARE = [
  { latitude: 27.5, longitude: 77.6 },
  { latitude: 27.5, longitude: 77.8 },
  { latitude: 27.7, longitude: 77.8 },
  { latitude: 27.7, longitude: 77.6 },
];

describe("polygonFromPoints", () => {
  it("closes the ring in GeoJSON [lng, lat] order", () => {
    const polygon = polygonFromPoints(SQUARE);
    expect(polygon.type).toBe("Polygon");
    expect(polygon.coordinates[0]).toHaveLength(5);
    expect(polygon.coordinates[0][0]).toEqual([77.6, 27.5]);
    expect(polygon.coordinates[0][4]).toEqual(polygon.coordinates[0][0]);
  });

  it("accepts an already-closed ring and drops repeated points", () => {
    const polygon = polygonFromPoints([...SQUARE, SQUARE[3], SQUARE[0]]);
    expect(pointsFromPolygon(polygon)).toEqual(SQUARE);
  });

  it("rejects fewer than three distinct points", () => {
    expect(() => polygonFromPoints([SQUARE[0], SQUARE[1], SQUARE[1]])).toThrow(
      ZoneGeometryError,
    );
  });

  it("rejects a boundary with no area", () => {
    const line = [
      { latitude: 27.5, longitude: 77.6 },
      { latitude: 27.6, longitude: 77.7 },
      { latitude: 27.7, longitude: 77.8 },
    ];
    expect(() => polygonFromPoints(line)).toThrow("encloses no area");
  });

  it("rejects a self-crossing (bow-tie) outline", () => {
    const bowTie = [SQUARE[0], SQUARE[2], SQUARE[1], SQUARE[3]];
    expect(() => polygonFromPoints(bowTie)).toThrow("crosses itself");
  });

  it("rejects out-of-range coordinates", () => {
    expect(() =>
      polygonFromPoints([
        ...SQUARE.slice(0, 3),
        { latitude: 91, longitude: 0 },
      ]),
    ).toThrow(ZoneGeometryError);
  });
});

describe("circlePoints", () => {
  it("approximates a circle that forms a valid polygon", () => {
    const points = circlePoints({ latitude: 27.58, longitude: 77.7 }, 10, 36);
    expect(points).toHaveLength(36);
    expect(() => polygonFromPoints(points)).not.toThrow();
    // Northernmost vertex ≈ 10 km north (~0.0904°).
    const north = Math.max(...points.map((point) => point.latitude));
    expect(north - 27.58).toBeCloseTo(0.0904, 3);
  });
});
