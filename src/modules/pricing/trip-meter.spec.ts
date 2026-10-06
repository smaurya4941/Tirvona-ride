import { measureTrip, resolveFinalFare } from "./trip-meter";
import type { TrailPoint } from "./trip-meter";

const RATES = {
  currency: "INR",
  baseFare: 30,
  perKmRate: 12,
  perMinuteRate: 1.5,
  minimumFare: 50,
};
const START = new Date("2026-09-28T10:00:00Z");

/** A straight northward trail: one fix every `everySeconds`, `metersPerFix` apart. */
function trail(
  fixes: number,
  everySeconds: number,
  metersPerFix: number,
): TrailPoint[] {
  const degreesPerMeter = 1 / 111_195;
  return Array.from({ length: fixes }, (_, index) => ({
    latitude: 27.5714 + index * metersPerFix * degreesPerMeter,
    longitude: 77.6716,
    recordedAt: new Date(START.getTime() + index * everySeconds * 1000),
  }));
}

describe("measureTrip", () => {
  it("sums the legs of a dense trail", () => {
    const measured = measureTrip(trail(41, 15, 100), 120); // 40 legs × 100 m
    expect(measured.reliable).toBe(true);
    expect(measured.distanceMeters).toBeGreaterThanOrEqual(3990);
    expect(measured.distanceMeters).toBeLessThanOrEqual(4010);
    expect(measured.maxGapSeconds).toBe(15);
  });

  it("is unreliable with fewer than two points", () => {
    expect(measureTrip(trail(1, 15, 100), 120)).toMatchObject({
      reliable: false,
      reason: "TOO_FEW_POINTS",
    });
    expect(measureTrip([], 120)).toMatchObject({
      reliable: false,
      distanceMeters: 0,
    });
  });

  it("is unreliable across a long GPS gap (under-measures)", () => {
    const points = trail(10, 15, 100);
    points.push({
      ...points[9],
      latitude: points[9].latitude + 0.02,
      recordedAt: new Date(START.getTime() + 20 * 60_000),
    });
    expect(measureTrip(points, 120)).toMatchObject({
      reliable: false,
      reason: "GAP_TOO_LONG",
    });
  });

  it("skips a GPS jump instead of billing it", () => {
    const points = trail(21, 15, 100);
    // One fix 5 km off the road, 15 s after the previous one (≈ 333 m/s).
    points[10] = { ...points[10], longitude: points[10].longitude + 0.05 };
    const measured = measureTrip(points, 120);
    expect(measured.reliable).toBe(true);
    expect(measured.distanceMeters).toBeLessThan(2100);
    expect(measured.distanceMeters).toBeGreaterThan(1900);
  });

  it("sorts fixes by time before measuring", () => {
    const points = trail(11, 15, 100).reverse();
    expect(measureTrip(points, 120).distanceMeters).toBeGreaterThanOrEqual(995);
  });
});

describe("resolveFinalFare", () => {
  const base = {
    rates: RATES,
    bookedDistanceMeters: 5000,
    bookedDurationSeconds: 900,
    estimatedFare: 113, // 30 + 60 + 22.5 → 112.5 → 113
    startedAt: START,
    completedAt: new Date(START.getTime() + 1200 * 1000),
    maxEstimateMultiplier: 1.5,
  };

  it("bills the booked route in booked mode", () => {
    const result = resolveFinalFare({ ...base, mode: "booked" });
    expect(result).toMatchObject({
      distanceSource: "BOOKED",
      durationSource: "BOOKED",
      distanceMeters: 5000,
      durationSeconds: 900,
    });
    expect(result.total).toBe(113);
  });

  it("bills actual time and trail distance in actual mode", () => {
    const measurement = measureTrip(trail(81, 15, 100), 120); // ≈ 8 km
    const result = resolveFinalFare({ ...base, mode: "actual", measurement });
    expect(result.distanceSource).toBe("ACTUAL");
    expect(result.durationSource).toBe("ACTUAL");
    expect(result.durationSeconds).toBe(1200);
    // 30 + 8 km × 12 + 20 min × 1.5 = 156
    expect(result.total).toBe(156);
    expect(result.capApplied).toBe(false);
  });

  it("falls back to the booked distance when the trail is unreliable", () => {
    const measurement = measureTrip(trail(1, 15, 100), 120);
    const result = resolveFinalFare({ ...base, mode: "actual", measurement });
    expect(result.distanceSource).toBe("BOOKED");
    expect(result.distanceMeters).toBe(5000);
    expect(result.measuredDistanceMeters).toBe(0);
  });

  it("caps the fare at estimate × multiplier and keeps the uncapped figure", () => {
    const measurement = measureTrip(trail(201, 15, 100), 120); // ≈ 20 km
    const result = resolveFinalFare({ ...base, mode: "actual", measurement });
    expect(result.capApplied).toBe(true);
    expect(result.total).toBe(170); // round(113 × 1.5)
    expect(result.uncappedFare).toBeGreaterThan(170);
  });

  it("applies no cap when the multiplier is 0", () => {
    const measurement = measureTrip(trail(201, 15, 100), 120);
    const result = resolveFinalFare({
      ...base,
      mode: "actual",
      measurement,
      maxEstimateMultiplier: 0,
    });
    expect(result.capApplied).toBe(false);
    expect(result.total).toBeGreaterThan(170);
  });

  it("charges less for a shorter trip, never below the minimum fare", () => {
    const measurement = measureTrip(trail(3, 15, 100), 120); // 200 m
    const result = resolveFinalFare({
      ...base,
      mode: "actual",
      measurement,
      completedAt: new Date(START.getTime() + 60_000),
    });
    expect(result.breakdown.minimumFareApplied).toBe(true);
    expect(result.total).toBe(50);
  });
});
