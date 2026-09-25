import { calculateFare } from "./fare-calculator";

const AUTO = {
  currency: "INR",
  baseFare: 30,
  perKmRate: 10,
  perMinuteRate: 1.5,
  minimumFare: 40,
};

describe("calculateFare", () => {
  it("adds base, distance and time charges", () => {
    // 5 km, 15 min → 30 + 50 + 22.5 = 102.5 → ₹103
    const fare = calculateFare(AUTO, 5_000, 900);
    expect(fare).toMatchObject({
      distanceKm: 5,
      durationMinutes: 15,
      distanceCharge: 50,
      timeCharge: 22.5,
      subtotal: 102.5,
      minimumFareApplied: false,
      total: 103,
    });
  });

  it("floors at the minimum fare", () => {
    // 0.5 km, 2 min → 30 + 5 + 3 = 38 < 40
    const fare = calculateFare(AUTO, 500, 120);
    expect(fare.subtotal).toBe(38);
    expect(fare.minimumFareApplied).toBe(true);
    expect(fare.total).toBe(40);
  });

  it("does not apply the minimum when the fare equals it", () => {
    // 30 + 10 × 1 km = 40, zero minutes
    const fare = calculateFare(AUTO, 1_000, 0);
    expect(fare.minimumFareApplied).toBe(false);
    expect(fare.total).toBe(40);
  });

  it("works in paise so fractional rates never drift", () => {
    const fare = calculateFare(
      { ...AUTO, baseFare: 0.1, perKmRate: 0.2, perMinuteRate: 0, minimumFare: 0 },
      1_000,
      0,
    );
    expect(fare.subtotal).toBe(0.3);
  });

  it("rounds the payable total to the nearest rupee", () => {
    // 30 + 10 × 2.345 + 0 = 53.45 → ₹53
    expect(calculateFare(AUTO, 2_345, 0).total).toBe(53);
    // 30 + 10 × 2.355 = 53.55 → ₹54
    expect(calculateFare(AUTO, 2_355, 0).total).toBe(54);
  });

  it("echoes the rates it used so a ride can snapshot them", () => {
    const fare = calculateFare(AUTO, 3_000, 600);
    expect(fare).toMatchObject(AUTO);
  });

  it("rejects negative inputs", () => {
    expect(() => calculateFare(AUTO, -1, 0)).toThrow(RangeError);
  });
});
