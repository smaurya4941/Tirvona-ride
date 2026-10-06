import {
  checkAvailability,
  distanceWarning,
  effectiveCapacity,
  localDate,
  localWeekday,
  publishProblems,
  tariffFor,
} from "./circuit-package.rules";
import type { PublishablePackage } from "./circuit-package.rules";

const TZ = "Asia/Kolkata";
/** The instant that reads this wall-clock time in India. */
const ist = (iso: string): Date => new Date(`${iso}+05:30`);

describe("availability", () => {
  const everyDay = {
    days: [0, 1, 2, 3, 4, 5, 6],
    opensAt: "06:00",
    closesAt: "20:00",
  };

  it("reads weekday and date on the business calendar, not UTC", () => {
    // 2026-10-05 is a Monday; 01:00 IST is still Sunday 19:30 UTC.
    expect(localWeekday(ist("2026-10-05T01:00:00"), TZ)).toBe(0);
    expect(localDate(ist("2026-10-05T01:00:00"), TZ)).toBe("2026-10-05");
    expect(localWeekday(ist("2026-10-04T23:59:00"), TZ)).toBe(6);
  });

  it("opens at the opening minute and closes at the closing minute (exclusive)", () => {
    expect(
      checkAvailability(everyDay, ist("2026-10-05T05:59:00"), TZ),
    ).toMatchObject({ open: false, reason: "OUTSIDE_HOURS" });
    expect(checkAvailability(everyDay, ist("2026-10-05T06:00:00"), TZ)).toEqual(
      { open: true },
    );
    expect(checkAvailability(everyDay, ist("2026-10-05T19:59:00"), TZ)).toEqual(
      { open: true },
    );
    expect(
      checkAvailability(everyDay, ist("2026-10-05T20:00:00"), TZ),
    ).toMatchObject({ open: false, reason: "OUTSIDE_HOURS" });
  });

  it("supports hours that cross midnight", () => {
    const night = {
      days: [0, 1, 2, 3, 4, 5, 6],
      opensAt: "22:00",
      closesAt: "04:00",
    };
    expect(checkAvailability(night, ist("2026-10-05T23:00:00"), TZ).open).toBe(
      true,
    );
    expect(checkAvailability(night, ist("2026-10-05T03:00:00"), TZ).open).toBe(
      true,
    );
    expect(checkAvailability(night, ist("2026-10-05T12:00:00"), TZ).open).toBe(
      false,
    );
  });

  it("closes on disabled weekdays", () => {
    const weekdays = { ...everyDay, days: [0, 1, 2, 3, 4] };
    expect(
      checkAvailability(weekdays, ist("2026-10-05T10:00:00"), TZ).open,
    ).toBe(true); // Monday
    expect(
      checkAvailability(weekdays, ist("2026-10-10T10:00:00"), TZ),
    ).toMatchObject({ open: false, reason: "CLOSED_TODAY" }); // Saturday
  });

  it("honours the season window, both ends inclusive", () => {
    const season = {
      ...everyDay,
      validFrom: "2026-10-05",
      validUntil: "2026-10-07",
    };
    expect(
      checkAvailability(season, ist("2026-10-04T10:00:00"), TZ),
    ).toMatchObject({ open: false, reason: "OUT_OF_SEASON" });
    expect(checkAvailability(season, ist("2026-10-05T10:00:00"), TZ).open).toBe(
      true,
    );
    expect(checkAvailability(season, ist("2026-10-07T19:00:00"), TZ).open).toBe(
      true,
    );
    expect(
      checkAvailability(season, ist("2026-10-08T10:00:00"), TZ),
    ).toMatchObject({ open: false, reason: "OUT_OF_SEASON" });
  });
});

describe("publishProblems", () => {
  const rideTypes = new Map([
    ["AUTO", { seatCapacity: 3 }],
    ["CAB", { seatCapacity: 4 }],
  ]);
  const stop = (order: number, name: string) => ({
    order,
    placeId: `featured:${name}`,
    name,
    address: `${name}, Vrindavan`,
    latitude: 27.5 + order / 100,
    longitude: 77.6,
  });
  const valid = (): PublishablePackage => ({
    name: "Vrindavan Spiritual Circuit",
    city: "Vrindavan",
    stops: [stop(1, "prem-mandir"), stop(2, "iskcon")],
    pricing: {
      includedDistanceMeters: 30_000,
      includedDurationSeconds: 18_000,
    },
    rideTypes: ["AUTO", "CAB"],
    vehiclePricing: [
      {
        rideType: "AUTO",
        basePrice: 600,
        extraDistanceRatePerKm: 15,
        extraDurationRatePerHour: 50,
      },
      {
        rideType: "CAB",
        basePrice: 1200,
        extraDistanceRatePerKm: 22,
        extraDurationRatePerHour: 120,
      },
    ],
    maxPassengers: 4,
    availability: {
      days: [0, 1, 2, 3, 4, 5, 6],
      opensAt: "06:00",
      closesAt: "20:00",
    },
  });

  it("accepts a complete package", () => {
    expect(publishProblems(valid(), rideTypes)).toEqual([]);
  });

  it("requires two stops, in order, each with a place id and coordinates", () => {
    const one = { ...valid(), stops: [stop(1, "prem-mandir")] };
    expect(publishProblems(one, rideTypes).map((p) => p.field)).toContain(
      "stops",
    );

    const shuffled = { ...valid(), stops: [stop(2, "a"), stop(1, "b")] };
    expect(
      publishProblems(shuffled, rideTypes).some((p) =>
        p.message.includes("out of order"),
      ),
    ).toBe(true);

    const noPlace = valid();
    noPlace.stops = [{ ...stop(1, "a"), placeId: "" }, stop(2, "b")];
    expect(
      publishProblems(noPlace, rideTypes).some((p) =>
        p.message.includes("place id"),
      ),
    ).toBe(true);

    const noCoords = valid();
    noCoords.stops = [{ ...stop(1, "a"), latitude: undefined }, stop(2, "b")];
    expect(
      publishProblems(noCoords, rideTypes).some((p) =>
        p.message.includes("coordinates"),
      ),
    ).toBe(true);
  });

  it("rejects the same place twice", () => {
    const twice = valid();
    twice.stops = [
      stop(1, "prem-mandir"),
      { ...stop(2, "x"), placeId: "featured:prem-mandir" },
    ];
    expect(
      publishProblems(twice, rideTypes).some((p) =>
        p.message.includes("twice"),
      ),
    ).toBe(true);
  });

  it("validates the included distance and time", () => {
    const free = valid();
    free.pricing = { includedDistanceMeters: 0, includedDurationSeconds: 0 };
    const fields = publishProblems(free, rideTypes).map((p) => p.field);
    expect(fields).toEqual(
      expect.arrayContaining([
        "pricing.includedDistance",
        "pricing.includedDuration",
      ]),
    );
    expect(
      publishProblems({ ...valid(), pricing: undefined }, rideTypes).map(
        (p) => p.field,
      ),
    ).toContain("pricing");
  });

  it("needs one valid price per allowed vehicle and none for others", () => {
    const missing = {
      ...valid(),
      vehiclePricing: valid().vehiclePricing.slice(0, 1),
    };
    expect(publishProblems(missing, rideTypes).map((p) => p.message)).toContain(
      "Set a price for CAB",
    );

    const bad = valid();
    bad.vehiclePricing = [
      {
        rideType: "AUTO",
        basePrice: 0,
        extraDistanceRatePerKm: -1,
        extraDurationRatePerHour: -1,
      },
      bad.vehiclePricing[1],
    ];
    expect(publishProblems(bad, rideTypes).map((p) => p.field)).toEqual(
      expect.arrayContaining([
        "vehiclePricing.basePrice",
        "vehiclePricing.extraDistanceRate",
        "vehiclePricing.extraDurationRate",
      ]),
    );

    const stray = { ...valid(), rideTypes: ["AUTO"] };
    expect(
      publishProblems(stray, rideTypes).some((p) =>
        p.message.includes("CAB is priced but not an allowed vehicle"),
      ),
    ).toBe(true);

    const twice = valid();
    twice.vehiclePricing = [
      ...twice.vehiclePricing,
      { ...twice.vehiclePricing[0] },
    ];
    expect(
      publishProblems(twice, rideTypes).some((p) =>
        p.message.includes("AUTO is priced twice"),
      ),
    ).toBe(true);
  });

  it("builds each vehicle tariff from its own price and the shared allowance", () => {
    expect(tariffFor(valid(), "CAB")).toEqual({
      rideType: "CAB",
      basePrice: 1200,
      extraDistanceRatePerKm: 22,
      extraDurationRatePerHour: 120,
      includedDistanceMeters: 30_000,
      includedDurationSeconds: 18_000,
    });
    expect(tariffFor(valid(), "AUTO")?.basePrice).toBe(600);
    expect(tariffFor(valid(), "BIKE")).toBeUndefined();
    expect(
      tariffFor({ ...valid(), pricing: undefined }, "AUTO"),
    ).toBeUndefined();
  });

  it("validates vehicles, passengers and the schedule", () => {
    expect(
      publishProblems({ ...valid(), rideTypes: [] }, rideTypes).map(
        (p) => p.field,
      ),
    ).toContain("rideTypes");
    expect(
      publishProblems({ ...valid(), rideTypes: ["TUKTUK"] }, rideTypes).some(
        (p) => p.message.includes("TUKTUK"),
      ),
    ).toBe(true);
    expect(
      publishProblems({ ...valid(), maxPassengers: 0 }, rideTypes).map(
        (p) => p.field,
      ),
    ).toContain("maxPassengers");
    const schedule = valid();
    schedule.availability = {
      days: [],
      opensAt: "06:00",
      closesAt: "06:00",
      validFrom: "2026-10-09",
      validUntil: "2026-10-01",
    };
    const fields = publishProblems(schedule, rideTypes).map((p) => p.field);
    expect(fields).toEqual(
      expect.arrayContaining([
        "availability.days",
        "availability.hours",
        "availability.validUntil",
      ]),
    );
  });
});

describe("capacity and distance warning", () => {
  it("never lets the package limit exceed what the vehicle seats", () => {
    expect(effectiveCapacity(4, 3)).toBe(3);
    expect(effectiveCapacity(2, 3)).toBe(2);
  });

  it("warns when the included distance cannot cover the stops", () => {
    expect(distanceWarning(20_000, 27_800)).toContain("lower than");
    expect(distanceWarning(30_000, 27_800)).toBeUndefined();
  });
});
