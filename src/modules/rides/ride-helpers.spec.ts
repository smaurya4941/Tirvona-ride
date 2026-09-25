import { startOfDayInTimeZone } from "../../common/utils/time";
import { generateRideCode } from "./ride-code";
import { generateRideOtp, rideOtpMatches } from "./ride-otp";

describe("ride OTP", () => {
  it("is always four digits", () => {
    for (let index = 0; index < 200; index += 1) expect(generateRideOtp()).toMatch(/^\d{4}$/);
  });

  it("matches only the exact code", () => {
    expect(rideOtpMatches("0421", "0421")).toBe(true);
    expect(rideOtpMatches("0422", "0421")).toBe(false);
    expect(rideOtpMatches("421", "0421")).toBe(false);
    expect(rideOtpMatches("0421", undefined)).toBe(false);
  });
});

describe("generateRideCode", () => {
  it("uses the unambiguous alphabet", () => {
    for (let index = 0; index < 100; index += 1)
      expect(generateRideCode()).toMatch(/^TR[2-9A-HJKMNP-Z]{8}$/);
  });
});

describe("startOfDayInTimeZone", () => {
  it("returns local midnight for IST (UTC+5:30)", () => {
    // 2026-03-10 02:00 IST == 2026-03-09 20:30 UTC
    const start = startOfDayInTimeZone(new Date("2026-03-09T20:30:00Z"), "Asia/Kolkata");
    expect(start.toISOString()).toBe("2026-03-09T18:30:00.000Z");
  });

  it("returns midnight for UTC", () => {
    const start = startOfDayInTimeZone(new Date("2026-03-09T20:30:00Z"), "UTC");
    expect(start.toISOString()).toBe("2026-03-09T00:00:00.000Z");
  });
});
