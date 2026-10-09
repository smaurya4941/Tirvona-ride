import {
  REVIEW_COMPLETION_MODES,
  RideCompletionMode,
  evaluateEndLocation,
  overrideAvailableAt,
} from "./ride-completion";

const DESTINATION = { latitude: 27.5806, longitude: 77.7006 };

describe("evaluateEndLocation", () => {
  it("does not flag a driver at the drop-off", () => {
    const result = evaluateEndLocation({
      location: { latitude: 27.5807, longitude: 77.7007 },
      destination: DESTINATION,
      farRadiusMeters: 500,
    });
    expect(result.farFromDestination).toBe(false);
    expect(result.distanceToDestinationMeters).toBeLessThan(50);
  });

  it("flags a driver further than the radius, and keeps the distance", () => {
    const result = evaluateEndLocation({
      location: { latitude: 27.5725, longitude: 77.677 }, // ~2.5 km away
      destination: DESTINATION,
      farRadiusMeters: 500,
    });
    expect(result.farFromDestination).toBe(true);
    expect(result.distanceToDestinationMeters).toBeGreaterThan(2_000);
  });

  it("treats exactly the radius as near", () => {
    const base = evaluateEndLocation({
      location: { latitude: 27.5725, longitude: 77.677 },
      destination: DESTINATION,
      farRadiusMeters: 0,
    });
    const atRadius = evaluateEndLocation({
      location: { latitude: 27.5725, longitude: 77.677 },
      destination: DESTINATION,
      farRadiusMeters: base.distanceToDestinationMeters!,
    });
    expect(atRadius.farFromDestination).toBe(false);
  });

  it("does not flag an unknown position: no GPS is not evidence", () => {
    expect(
      evaluateEndLocation({
        destination: DESTINATION,
        farRadiusMeters: 500,
      }),
    ).toEqual({ farFromDestination: false });
  });

  it("carries when the position was recorded", () => {
    const updatedAt = new Date("2026-10-07T08:00:00Z");
    expect(
      evaluateEndLocation({
        location: { ...DESTINATION, updatedAt },
        destination: DESTINATION,
        farRadiusMeters: 500,
      }).locationAt,
    ).toEqual(updatedAt);
  });
});

describe("overrideAvailableAt", () => {
  it("is the request plus the wait", () => {
    expect(
      overrideAvailableAt(new Date("2026-10-07T08:00:00Z"), 120).toISOString(),
    ).toBe("2026-10-07T08:02:00.000Z");
  });
});

describe("REVIEW_COMPLETION_MODES", () => {
  it("asks support to look at everything but the rider's own code", () => {
    expect(REVIEW_COMPLETION_MODES).toEqual(
      expect.arrayContaining([
        RideCompletionMode.DRIVER_OVERRIDE,
        RideCompletionMode.ADMIN,
        RideCompletionMode.SOS,
      ]),
    );
    expect(REVIEW_COMPLETION_MODES).not.toContain(RideCompletionMode.OTP);
    expect(REVIEW_COMPLETION_MODES).not.toContain(
      RideCompletionMode.NOT_REQUIRED,
    );
  });
});
