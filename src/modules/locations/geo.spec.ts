import { ConfigService } from "@nestjs/config";
import { fromGeoJsonPoint, haversineMeters, toGeoJsonPoint } from "./geo";
import { HaversineRouteEstimator } from "./haversine-route-estimator";

const PREM_MANDIR = { latitude: 27.5714, longitude: 77.6716 };
const BANKE_BIHARI = { latitude: 27.5806, longitude: 77.7006 };

describe("haversineMeters", () => {
  it("is zero for the same point", () => {
    expect(haversineMeters(PREM_MANDIR, PREM_MANDIR)).toBe(0);
  });

  it("matches the arc length of one degree on the equator", () => {
    // 2πR / 360 with the IUGG mean radius = 111,195.08 m.
    const meters = haversineMeters({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 1 });
    expect(meters).toBeCloseTo(111_195.08, 1);
  });

  it("matches one degree of latitude anywhere", () => {
    const meters = haversineMeters({ latitude: 27, longitude: 77 }, { latitude: 28, longitude: 77 });
    expect(meters).toBeCloseTo(111_195.08, 1);
  });

  it("is symmetric", () => {
    expect(haversineMeters(PREM_MANDIR, BANKE_BIHARI)).toBeCloseTo(
      haversineMeters(BANKE_BIHARI, PREM_MANDIR),
      6,
    );
  });

  it("round-trips GeoJSON's [longitude, latitude] order", () => {
    const point = toGeoJsonPoint(PREM_MANDIR);
    expect(point.coordinates).toEqual([77.6716, 27.5714]);
    expect(fromGeoJsonPoint(point)).toEqual(PREM_MANDIR);
  });
});

describe("HaversineRouteEstimator", () => {
  const estimator = (speed: number, factor = 1) =>
    new HaversineRouteEstimator(
      new ConfigService({ routeAverageSpeedKmph: speed, routeDistanceFactor: factor }),
    );

  it("derives duration from the configured average speed", async () => {
    const estimate = await estimator(20).estimate(PREM_MANDIR, BANKE_BIHARI);
    const expectedMeters = Math.round(haversineMeters(PREM_MANDIR, BANKE_BIHARI));
    expect(estimate.distanceMeters).toBe(expectedMeters);
    expect(estimate.durationSeconds).toBe(Math.round(expectedMeters / (20_000 / 3600)));
    expect(estimate.provider).toBe("HAVERSINE");
  });

  it("applies the detour factor", async () => {
    const plain = await estimator(20).estimate(PREM_MANDIR, BANKE_BIHARI);
    const scaled = await estimator(20, 1.3).estimate(PREM_MANDIR, BANKE_BIHARI);
    expect(scaled.distanceMeters).toBeCloseTo(plain.distanceMeters * 1.3, -1);
  });

  it("never quotes less than a minute", async () => {
    const estimate = await estimator(20).estimate(PREM_MANDIR, {
      latitude: 27.5715,
      longitude: 77.6716,
    });
    expect(estimate.durationSeconds).toBe(60);
  });
});
