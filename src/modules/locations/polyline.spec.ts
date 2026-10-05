import { decodePolyline, encodePolyline, joinLegs } from "./polyline";

// The reference example from Google's polyline algorithm documentation.
const GOOGLE_EXAMPLE = "_p~iF~ps|U_ulLnnqC_mqNvxq`@";

describe("polyline", () => {
  it("decodes Google's reference example", () => {
    const points = decodePolyline(GOOGLE_EXAMPLE);
    expect(points).toEqual([
      { latitude: 38.5, longitude: -120.2 },
      { latitude: 40.7, longitude: -120.95 },
      { latitude: 43.252, longitude: -126.453 },
    ]);
  });

  it("round-trips", () => {
    expect(encodePolyline(decodePolyline(GOOGLE_EXAMPLE))).toBe(GOOGLE_EXAMPLE);
  });

  it("rejects a truncated polyline", () => {
    expect(() => decodePolyline("_p~iF~ps|U")).not.toThrow();
    // A latitude with no longitude after it.
    expect(() => decodePolyline("_p~iF~ps|U_ulL")).toThrow(RangeError);
  });

  it("joins legs without repeating the shared point, using straight lines for legs without a path", () => {
    const a = { latitude: 27.5, longitude: 77.6 };
    const b = { latitude: 27.6, longitude: 77.7 };
    const c = { latitude: 27.7, longitude: 77.8 };
    const road = encodePolyline([a, { latitude: 27.55, longitude: 77.62 }, b]);
    const joined = joinLegs([
      { from: a, to: b, polyline: road },
      { from: b, to: c },
    ]);
    expect(decodePolyline(joined!)).toEqual([a, { latitude: 27.55, longitude: 77.62 }, b, c]);
    expect(joinLegs([{ from: a, to: b }])).toBeUndefined();
  });
});
