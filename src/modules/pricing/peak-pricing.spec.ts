import { calculateFare } from "./fare-calculator";
import {
  effectivePerKmRate,
  findConflict,
  formatTimeOfDay,
  minuteOfDay,
  parseTimeOfDay,
  peakRates,
  resolvePeak,
  windowContains,
  windowsOverlap,
} from "./peak-pricing";
import type { PeakRule } from "./peak-pricing";

const IST = "Asia/Kolkata";
/** A UTC instant that reads `hh:mm` on the wall clock in IST (UTC+5:30, no DST). */
const at = (hhmm: string, seconds = 0): Date => {
  const [h, m] = hhmm.split(":").map(Number);
  const utcMinutes = (h * 60 + m - 330 + 1440) % 1440;
  return new Date(Date.UTC(2026, 9, 3, Math.floor(utcMinutes / 60), utcMinutes % 60, seconds));
};
const minute = (hhmm: string, seconds = 0): number => minuteOfDay(at(hhmm, seconds), IST);

const rule = (over: Partial<PeakRule> & Pick<PeakRule, "startTime" | "endTime">): PeakRule => ({
  id: over.id ?? "slot",
  name: over.name ?? "Peak",
  hikePercent: over.hikePercent ?? 50,
  appliesToAll: over.appliesToAll ?? true,
  rideTypes: over.rideTypes ?? [],
  ...over,
});

describe("time of day", () => {
  it("reads the business wall clock, not UTC", () => {
    expect(minuteOfDay(new Date("2026-10-03T10:30:00Z"), IST)).toBe(16 * 60);
    expect(minuteOfDay(new Date("2026-10-03T18:29:59Z"), IST)).toBe(23 * 60 + 59);
    expect(minuteOfDay(new Date("2026-10-03T18:30:00Z"), IST)).toBe(0);
  });

  it("parses and formats HH:mm", () => {
    expect(parseTimeOfDay("00:00")).toBe(0);
    expect(parseTimeOfDay("23:59")).toBe(1439);
    for (const bad of ["24:00", "9:00", "12:60", "", "noon"]) expect(() => parseTimeOfDay(bad)).toThrow(RangeError);
    expect(formatTimeOfDay("16:00")).toBe("4:00 PM");
    expect(formatTimeOfDay("00:30")).toBe("12:30 AM");
    expect(formatTimeOfDay("12:00")).toBe("12:00 PM");
  });
});

describe("slot boundaries (start inclusive, end exclusive)", () => {
  const evening = { startTime: "16:00", endTime: "20:00" };
  it.each([
    ["15:00", false],
    ["15:59", false],
    ["16:00", true],
    ["17:30", true],
    ["19:59", true],
    ["20:00", false],
  ])("%s → peak %s", (time, expected) => {
    expect(windowContains(evening, minute(time))).toBe(expected);
  });

  it("is decided by the minute, so 3:59:59 PM is normal and 7:59:59 PM is peak", () => {
    expect(windowContains(evening, minute("15:59", 59))).toBe(false);
    expect(windowContains(evening, minute("19:59", 59))).toBe(true);
  });
});

describe("slots that cross midnight (10 PM → 2 AM)", () => {
  const night = { startTime: "22:00", endTime: "02:00" };
  it.each([
    ["21:59", false],
    ["22:00", true],
    ["23:30", true],
    ["00:00", true],
    ["00:30", true],
    ["01:59", true],
    ["02:00", false],
    ["12:00", false],
  ])("%s → peak %s", (time, expected) => {
    expect(windowContains(night, minute(time))).toBe(expected);
  });
});

describe("resolvePeak with several slots", () => {
  const rules = [
    rule({ id: "morning", name: "Morning", startTime: "08:00", endTime: "10:00", hikePercent: 25 }),
    rule({ id: "evening", name: "Evening", startTime: "16:00", endTime: "20:00", hikePercent: 50 }),
    rule({ id: "night", name: "Night", startTime: "22:00", endTime: "02:00", hikePercent: 20, appliesToAll: false, rideTypes: ["CAB"] }),
  ];
  const hike = (rideType: string, time: string) => resolvePeak(rules, rideType, minute(time))?.hikePercent;

  it("picks the slot for the time", () => {
    expect(hike("CAB", "09:00")).toBe(25);
    expect(hike("CAB", "12:00")).toBeUndefined();
    expect(hike("CAB", "17:00")).toBe(50);
    expect(hike("CAB", "21:00")).toBeUndefined();
  });

  it("honours the ride-type scope", () => {
    expect(hike("CAB", "23:00")).toBe(20);
    expect(hike("CAB", "01:00")).toBe(20);
    expect(hike("AUTO", "23:00")).toBeUndefined();
    expect(hike("AUTO", "17:00")).toBe(50);
  });
});

describe("overlap detection", () => {
  it("detects overlapping and touching windows correctly", () => {
    expect(windowsOverlap({ startTime: "16:00", endTime: "20:00" }, { startTime: "19:00", endTime: "22:00" })).toBe(true);
    // End is exclusive, so back-to-back slots are fine.
    expect(windowsOverlap({ startTime: "16:00", endTime: "20:00" }, { startTime: "20:00", endTime: "22:00" })).toBe(false);
    expect(windowsOverlap({ startTime: "08:00", endTime: "10:00" }, { startTime: "16:00", endTime: "20:00" })).toBe(false);
  });

  it("handles cross-midnight windows on both sides of midnight", () => {
    const night = { startTime: "22:00", endTime: "02:00" };
    expect(windowsOverlap(night, { startTime: "23:00", endTime: "23:30" })).toBe(true);
    expect(windowsOverlap(night, { startTime: "01:00", endTime: "03:00" })).toBe(true);
    expect(windowsOverlap(night, { startTime: "02:00", endTime: "22:00" })).toBe(false);
    expect(windowsOverlap(night, { startTime: "20:00", endTime: "23:00" })).toBe(true);
    expect(windowsOverlap(night, { startTime: "23:00", endTime: "01:00" })).toBe(true);
  });

  it("only conflicts for a shared ride type", () => {
    const existing = [rule({ id: "a", startTime: "16:00", endTime: "20:00", appliesToAll: false, rideTypes: ["CAB"] })];
    const candidate = (rideTypes: string[], appliesToAll = false) =>
      rule({ id: "new", startTime: "19:00", endTime: "22:00", appliesToAll, rideTypes });
    expect(findConflict(candidate(["CAB", "BIKE"]), existing)?.id).toBe("a");
    expect(findConflict(candidate(["BIKE"]), existing)).toBeUndefined();
    expect(findConflict(candidate([], true), existing)?.id).toBe("a");
  });

  it("does not conflict with itself when edited", () => {
    const self = rule({ id: "a", startTime: "16:00", endTime: "20:00" });
    expect(findConflict({ ...self, endTime: "21:00" }, [self])).toBeUndefined();
  });
});

describe("the hike moves only the per-km rate", () => {
  const rates = { currency: "INR", baseFare: 100, perKmRate: 18, perMinuteRate: 2, minimumFare: 100 };

  it("₹18 + 50% = ₹27, rounded to the paisa", () => {
    expect(effectivePerKmRate(18, 50)).toBe(27);
    expect(effectivePerKmRate(14, 12.5)).toBe(15.75);
    expect(effectivePerKmRate(10, 0.01)).toBe(10);
    expect(effectivePerKmRate(7, 33.33)).toBe(9.33);
  });

  it("leaves base fare, per-minute and minimum fare alone", () => {
    expect(peakRates(rates, 50)).toEqual({ ...rates, perKmRate: 27 });
  });

  it("10 km / 15 min: ₹100 + 10×₹27 + 15×₹2 = ₹400 (normal: ₹310)", () => {
    const peak = calculateFare(peakRates(rates, 50), 10_000, 15 * 60);
    expect(peak).toMatchObject({ perKmRate: 27, distanceCharge: 270, timeCharge: 30, total: 400 });
    expect(calculateFare(rates, 10_000, 15 * 60)).toMatchObject({ perKmRate: 18, distanceCharge: 180, total: 310 });
  });

  it("still applies the minimum fare after the hike", () => {
    const short = calculateFare(peakRates({ ...rates, baseFare: 20, minimumFare: 100 }, 50), 500, 60);
    expect(short).toMatchObject({ minimumFareApplied: true, total: 100 });
  });
});
