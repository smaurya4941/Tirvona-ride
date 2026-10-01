import { MIN_PAYABLE_RUPEES, PromoDiscountType, PromoStatus, computeDiscount, evaluatePromo, precheckPromo } from "./promo-rules";
import type { PromoEligibilityRules } from "./promo-rules";

const NOW = new Date("2026-09-26T10:00:00Z");

const promo = (overrides: Partial<PromoEligibilityRules> = {}): PromoEligibilityRules => ({
  status: PromoStatus.ACTIVE,
  startsAt: new Date("2026-09-01T00:00:00Z"),
  endsAt: new Date("2026-10-01T00:00:00Z"),
  applicableRideTypes: [],
  usageLimit: null,
  usedCount: 0,
  perUserLimit: 1,
  discountType: PromoDiscountType.PERCENTAGE,
  discountValue: 20,
  maxDiscount: 50,
  minRideValue: 60,
  ...overrides,
});

const context = (overrides: Partial<{ rideType: string; fare: number; userUses: number; now: Date }> = {}) => ({
  now: NOW,
  rideType: "AUTO",
  fare: 150,
  userUses: 0,
  ...overrides,
});

describe("computeDiscount", () => {
  it("takes a percentage of the fare, rounded down to whole rupees", () => {
    expect(computeDiscount({ discountType: PromoDiscountType.PERCENTAGE, discountValue: 15 }, 99)).toBe(14);
  });

  it("caps a percentage discount at maxDiscount", () => {
    expect(computeDiscount({ discountType: PromoDiscountType.PERCENTAGE, discountValue: 50, maxDiscount: 40 }, 300)).toBe(40);
  });

  it("applies a flat discount", () => {
    expect(computeDiscount({ discountType: PromoDiscountType.FLAT, discountValue: 25 }, 120)).toBe(25);
  });

  it("never makes a ride free: the customer pays at least ₹1", () => {
    expect(computeDiscount({ discountType: PromoDiscountType.FLAT, discountValue: 500 }, 80)).toBe(80 - MIN_PAYABLE_RUPEES);
    expect(computeDiscount({ discountType: PromoDiscountType.PERCENTAGE, discountValue: 100 }, 80)).toBe(79);
  });

  it("gives nothing on a zero, ₹1 or invalid fare", () => {
    for (const fare of [0, 1, -5, Number.NaN])
      expect(computeDiscount({ discountType: PromoDiscountType.FLAT, discountValue: 20 }, fare)).toBe(0);
  });

  it("is deterministic", () => {
    const rules = { discountType: PromoDiscountType.PERCENTAGE, discountValue: 17.5, maxDiscount: 60 };
    expect(new Set(Array.from({ length: 10 }, () => computeDiscount(rules, 333))).size).toBe(1);
  });
});

describe("evaluatePromo", () => {
  it("accepts a valid promo and returns discount and payable", () => {
    expect(evaluatePromo(promo(), context())).toEqual({ ok: true, discount: 30, payable: 120 });
  });

  it.each([
    ["inactive", promo({ status: PromoStatus.INACTIVE }), context(), "PROMO_INACTIVE"],
    ["not started", promo({ startsAt: new Date("2026-09-27T00:00:00Z") }), context(), "PROMO_NOT_STARTED"],
    ["expired", promo({ endsAt: new Date("2026-09-26T09:59:59Z") }), context(), "PROMO_EXPIRED"],
    ["expired exactly at endsAt", promo({ endsAt: NOW }), context(), "PROMO_EXPIRED"],
    ["wrong ride type", promo({ applicableRideTypes: ["CAB", "BIKE"] }), context(), "PROMO_RIDE_TYPE_NOT_ELIGIBLE"],
    ["below minimum fare", promo(), context({ fare: 59 }), "PROMO_MIN_FARE_NOT_MET"],
    ["global limit reached", promo({ usageLimit: 100, usedCount: 100 }), context(), "PROMO_USAGE_LIMIT_REACHED"],
    ["user limit reached", promo({ perUserLimit: 2 }), context({ userUses: 2 }), "PROMO_USER_LIMIT_REACHED"],
  ])("rejects a promo that is %s", (_label, rules, ctx, code) => {
    const result = evaluatePromo(rules, ctx);
    expect(result).toMatchObject({ ok: false, code });
  });

  it("accepts an eligible ride type from the list", () => {
    expect(evaluatePromo(promo({ applicableRideTypes: ["AUTO"] }), context()).ok).toBe(true);
  });

  it("accepts exactly the minimum fare and the last global use", () => {
    expect(evaluatePromo(promo({ usageLimit: 10, usedCount: 9 }), context({ fare: 60 })).ok).toBe(true);
  });

  it("reports the first failing rule (inactive beats expired)", () => {
    const result = evaluatePromo(promo({ status: PromoStatus.INACTIVE, endsAt: new Date("2020-01-01") }), context());
    expect(result).toMatchObject({ code: "PROMO_INACTIVE" });
  });
});

describe("precheckPromo (no trip yet)", () => {
  it("accepts a live code without looking at ride type or minimum fare", () => {
    expect(precheckPromo(promo({ applicableRideTypes: ["BIKE"], minRideValue: 5_000 }), { now: NOW, userUses: 0 })).toEqual({ ok: true });
  });

  it.each([
    ["PROMO_INACTIVE", { status: PromoStatus.INACTIVE }, 0],
    ["PROMO_NOT_STARTED", { startsAt: new Date("2026-09-27T00:00:00Z") }, 0],
    ["PROMO_EXPIRED", { endsAt: NOW }, 0],
    ["PROMO_USAGE_LIMIT_REACHED", { usageLimit: 3, usedCount: 3 }, 0],
    ["PROMO_USER_LIMIT_REACHED", {}, 1],
  ] as const)("refuses with %s", (code, overrides, userUses) => {
    expect(precheckPromo(promo(overrides), { now: NOW, userUses })).toMatchObject({ ok: false, code });
  });
});
