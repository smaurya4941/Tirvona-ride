import { checkTripDistance, distanceLimitsProblem, maxDistanceMeters, radiiProblem } from "./distance-policy";

const LIMITS = { minDistanceMeters: 200, maxDistanceKm: 80 };

describe("checkTripDistance", () => {
  it.each([
    ["slightly below the minimum", 199.9, "RIDE_TOO_SHORT"],
    ["exactly the minimum", 200, null],
    ["slightly above the minimum", 200.1, null],
    ["slightly below the maximum", 79_999.9, null],
    ["exactly the maximum", 80_000, null],
    ["slightly above the maximum", 80_000.1, "RIDE_TOO_LONG"],
  ])("%s", (_label, meters, expected) => {
    expect(checkTripDistance(LIMITS, meters)?.code ?? null).toBe(expected);
  });

  it("reports the limit that was broken, in metres", () => {
    expect(checkTripDistance(LIMITS, 10)?.data).toEqual({ minDistanceMeters: 200 });
    expect(checkTripDistance(LIMITS, 90_000)?.data).toEqual({ maxDistanceMeters: 80_000 });
  });

  it("judges each ride type by its own limits", () => {
    const bike = { minDistanceMeters: 200, maxDistanceKm: 40 };
    const auto = { minDistanceMeters: 500, maxDistanceKm: 60 };
    const cab = { minDistanceMeters: 1_000, maxDistanceKm: 100 };
    expect(checkTripDistance(bike, 300)).toBeNull();
    expect(checkTripDistance(auto, 300)?.code).toBe("RIDE_TOO_SHORT");
    expect(checkTripDistance(cab, 300)?.code).toBe("RIDE_TOO_SHORT");
    expect(checkTripDistance(bike, 50_000)?.code).toBe("RIDE_TOO_LONG");
    expect(checkTripDistance(auto, 50_000)).toBeNull();
    expect(checkTripDistance(cab, 50_000)).toBeNull();
  });

  it("supports fractional maximums without drift", () => {
    expect(maxDistanceMeters({ minDistanceMeters: 100, maxDistanceKm: 2.5 })).toBe(2_500);
    expect(maxDistanceMeters({ minDistanceMeters: 100, maxDistanceKm: 0.1 + 0.2 })).toBe(300);
  });
});

describe("distanceLimitsProblem", () => {
  it("accepts sound limits", () => {
    expect(distanceLimitsProblem(LIMITS)).toBeNull();
  });

  it.each([
    ["missing minimum", { maxDistanceKm: 10 }],
    ["missing maximum", { minDistanceMeters: 10 }],
    ["zero minimum", { minDistanceMeters: 0, maxDistanceKm: 10 }],
    ["negative minimum", { minDistanceMeters: -5, maxDistanceKm: 10 }],
    ["zero maximum", { minDistanceMeters: 200, maxDistanceKm: 0 }],
    ["negative maximum", { minDistanceMeters: 200, maxDistanceKm: -1 }],
    ["NaN", { minDistanceMeters: Number.NaN, maxDistanceKm: 10 }],
    ["Infinity", { minDistanceMeters: 200, maxDistanceKm: Number.POSITIVE_INFINITY }],
    ["minimum equal to maximum", { minDistanceMeters: 5_000, maxDistanceKm: 5 }],
    ["minimum above maximum", { minDistanceMeters: 6_000, maxDistanceKm: 5 }],
    ["absurd maximum", { minDistanceMeters: 200, maxDistanceKm: 5_000 }],
    ["absurd minimum", { minDistanceMeters: 60_000, maxDistanceKm: 900 }],
  ])("rejects %s", (_label, limits) => {
    expect(distanceLimitsProblem(limits)).not.toBeNull();
  });
});

describe("radiiProblem", () => {
  it("accepts sound radii and rejects bad ones", () => {
    expect(radiiProblem({ matchingRadiusKm: 8, nearbyDriversRadiusKm: 3 })).toBeNull();
    expect(radiiProblem({ matchingRadiusKm: 0, nearbyDriversRadiusKm: 3 })).not.toBeNull();
    expect(radiiProblem({ matchingRadiusKm: 8, nearbyDriversRadiusKm: -1 })).not.toBeNull();
    expect(radiiProblem({ matchingRadiusKm: 500, nearbyDriversRadiusKm: 3 })).not.toBeNull();
    expect(radiiProblem({ matchingRadiusKm: 8 })).not.toBeNull();
    expect(radiiProblem({ matchingRadiusKm: "8", nearbyDriversRadiusKm: 3 })).not.toBeNull();
  });
});
