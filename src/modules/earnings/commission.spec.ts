import { percentOfPaise, toPaise, toRupees } from "../../common/utils/money";
import { splitFare } from "./commission";

describe("splitFare", () => {
  it("keeps 20% of ₹200 and gives the driver ₹160", () => {
    expect(splitFare(toPaise(200), 20)).toEqual({
      grossFarePaise: 20_000,
      commissionRate: 20,
      commissionPaise: 4_000,
      netEarningPaise: 16_000,
    });
  });

  it("handles fractional results exactly: ₹350 at 15% → ₹52.50 / ₹297.50", () => {
    const split = splitFare(toPaise(350), 15);
    expect(toRupees(split.commissionPaise)).toBe(52.5);
    expect(toRupees(split.netEarningPaise)).toBe(297.5);
  });

  it("supports two-decimal rates (17.5%)", () => {
    expect(splitFare(toPaise(195), 17.5).commissionPaise).toBe(3_413); // 3412.5 → half-up
  });

  it("always adds back up to the gross fare", () => {
    for (const rupees of [1, 37, 99.99, 180, 195, 1_234.56]) {
      for (const rate of [0, 7.25, 15, 18, 20, 33.33, 100]) {
        const split = splitFare(toPaise(rupees), rate);
        expect(split.commissionPaise + split.netEarningPaise).toBe(split.grossFarePaise);
        expect(Number.isInteger(split.commissionPaise)).toBe(true);
        expect(split.netEarningPaise).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("handles 0% and 100%", () => {
    expect(splitFare(25_000, 0).netEarningPaise).toBe(25_000);
    expect(splitFare(25_000, 100).netEarningPaise).toBe(0);
  });
});

describe("money helpers", () => {
  it("converts without floating-point drift", () => {
    expect(toPaise(0.1 + 0.2)).toBe(30);
    expect(toPaise(195.5)).toBe(19_550);
    expect(toRupees(19_550)).toBe(195.5);
  });

  it("rejects out-of-range inputs", () => {
    expect(() => percentOfPaise(-1, 10)).toThrow(RangeError);
    expect(() => percentOfPaise(1.5, 10)).toThrow(RangeError);
    expect(() => percentOfPaise(100, 101)).toThrow(RangeError);
  });
});
