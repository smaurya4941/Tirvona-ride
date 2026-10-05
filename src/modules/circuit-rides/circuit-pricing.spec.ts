import { calculateCircuitFare, dueWarnings } from "./circuit-pricing";

// ₹600 · 30 km · 5 h · ₹15/km · ₹50/h — the worked example in the circuit spec.
const tariff = {
  basePrice: 600,
  includedDistanceMeters: 30_000,
  includedDurationSeconds: 5 * 3600,
  extraDistanceRatePerKm: 15,
  extraDurationRatePerHour: 50,
};
const HOUR = 3600;

describe("calculateCircuitFare", () => {
  it.each([
    ["within both", 29_000, 4 * HOUR, 600],
    ["extra distance only (35 km, 4 h)", 35_000, 4 * HOUR, 675],
    ["extra time only (29 km, 6 h)", 29_000, 6 * HOUR, 650],
    ["both exceeded (35 km, 6 h)", 35_000, 6 * HOUR, 725],
    ["exactly the included usage", 30_000, 5 * HOUR, 600],
  ])("%s → ₹%d", (_label, distance, duration, expected) => {
    expect(calculateCircuitFare(tariff, distance, duration).total).toBe(expected);
  });

  it("bills started kilometres and started 15-minute blocks", () => {
    const fare = calculateCircuitFare(tariff, 30_200, 5 * HOUR + 60);
    expect(fare.extraKm).toBe(1);
    expect(fare.extraDistanceCharge).toBe(15);
    expect(fare.extraBlocks).toBe(1);
    expect(fare.extraDurationCharge).toBe(12.5);
    // 600 + 15 + 12.50 = 627.50 → whole rupees.
    expect(fare.subtotal).toBe(627.5);
    expect(fare.total).toBe(628);
  });

  it("an hour over is four blocks and costs the hourly rate", () => {
    const fare = calculateCircuitFare(tariff, 0, 6 * HOUR);
    expect(fare.extraBlocks).toBe(4);
    expect(fare.extraDurationCharge).toBe(50);
  });

  it("is free of extras when the rates are zero", () => {
    expect(calculateCircuitFare({ ...tariff, extraDistanceRatePerKm: 0, extraDurationRatePerHour: 0 }, 99_000, 9 * HOUR).total).toBe(600);
  });

  it("rejects negative usage", () => {
    expect(() => calculateCircuitFare(tariff, -1, 0)).toThrow(RangeError);
  });
});

describe("dueWarnings", () => {
  const included = { includedDistanceMeters: 30_000, includedDurationSeconds: 5 * HOUR };

  it("is quiet while there is plenty of both", () => {
    expect(dueWarnings(included, 5_000, 1 * HOUR)).toEqual([]);
  });

  it("warns 30 and then 10 minutes before the included time ends, never both at once", () => {
    expect(dueWarnings(included, 0, 5 * HOUR - 29 * 60)).toEqual(["TIME_30_MIN"]);
    expect(dueWarnings(included, 0, 5 * HOUR - 9 * 60)).toEqual(["TIME_10_MIN"]);
    expect(dueWarnings(included, 0, 5 * HOUR + 1)).toEqual(["TIME_EXHAUSTED"]);
  });

  it("warns at 80% and at 100% of the included distance", () => {
    expect(dueWarnings(included, 24_000, 0)).toEqual(["DISTANCE_80"]);
    expect(dueWarnings(included, 23_999, 0)).toEqual([]);
    expect(dueWarnings(included, 30_000, 0)).toEqual(["DISTANCE_EXHAUSTED"]);
  });

  it("can warn about time and distance together", () => {
    expect(dueWarnings(included, 31_000, 5 * HOUR - 5 * 60)).toEqual(["TIME_10_MIN", "DISTANCE_EXHAUSTED"]);
  });
});
