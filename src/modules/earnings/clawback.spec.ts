import { refundClawback } from "./clawback";

// ₹350 ride at 15%: commission ₹52.50, driver ₹297.50.
const EARNING = {
  grossFarePaise: 35_000,
  commissionPaise: 5_250,
  netEarningPaise: 29_750,
};
const NONE = { grossPaise: 0, commissionPaise: 0 };

describe("refundClawback", () => {
  it("a full refund reverses the whole line", () => {
    expect(
      refundClawback({
        earning: EARNING,
        paidAmountPaise: 35_000,
        refundAmountPaise: 35_000,
        previousRefundsPaise: 0,
        previous: NONE,
      }),
    ).toEqual({
      grossReversalPaise: 35_000,
      commissionReversalPaise: 5_250,
      amountPaise: 29_750,
    });
  });

  it("a partial refund reverses the same fraction at the line's own rate", () => {
    // ₹70 of ₹350 = 20% → gross ₹70, commission ₹10.50, driver ₹59.50
    expect(
      refundClawback({
        earning: EARNING,
        paidAmountPaise: 35_000,
        refundAmountPaise: 7_000,
        previousRefundsPaise: 0,
        previous: NONE,
      }),
    ).toEqual({
      grossReversalPaise: 7_000,
      commissionReversalPaise: 1_050,
      amountPaise: 5_950,
    });
  });

  it("partials that add up to a full refund leave no rounding residue", () => {
    // ₹100 fare at 17.5% → commission ₹17.50; refund ₹33.33 + ₹33.33 + ₹33.34.
    const earning = {
      grossFarePaise: 10_000,
      commissionPaise: 1_750,
      netEarningPaise: 8_250,
    };
    let previous = { grossPaise: 0, commissionPaise: 0 };
    let refunded = 0;
    let driver = 0;
    for (const refund of [3_333, 3_333, 3_334]) {
      const result = refundClawback({
        earning,
        paidAmountPaise: 10_000,
        refundAmountPaise: refund,
        previousRefundsPaise: refunded,
        previous,
      });
      previous = {
        grossPaise: previous.grossPaise + result.grossReversalPaise,
        commissionPaise:
          previous.commissionPaise + result.commissionReversalPaise,
      };
      refunded += refund;
      driver += result.amountPaise;
    }
    expect(previous).toEqual({ grossPaise: 10_000, commissionPaise: 1_750 });
    expect(driver).toBe(8_250);
  });

  it("with a platform-funded promo, a full refund of what was paid still reverses the whole line", () => {
    // Fare ₹100, promo ₹20 → customer paid ₹80; driver earned on ₹100.
    const earning = {
      grossFarePaise: 10_000,
      commissionPaise: 2_000,
      netEarningPaise: 8_000,
    };
    expect(
      refundClawback({
        earning,
        paidAmountPaise: 8_000,
        refundAmountPaise: 8_000,
        previousRefundsPaise: 0,
        previous: NONE,
      }),
    ).toEqual({
      grossReversalPaise: 10_000,
      commissionReversalPaise: 2_000,
      amountPaise: 8_000,
    });
  });

  it("never reverses more than the line recorded", () => {
    const result = refundClawback({
      earning: EARNING,
      paidAmountPaise: 35_000,
      refundAmountPaise: 20_000,
      previousRefundsPaise: 0,
      previous: { grossPaise: 30_000, commissionPaise: 4_500 },
    });
    expect(result.grossReversalPaise).toBe(5_000);
    expect(result.commissionReversalPaise).toBeLessThanOrEqual(750);
  });

  it("ignores zero amounts", () => {
    expect(
      refundClawback({
        earning: EARNING,
        paidAmountPaise: 0,
        refundAmountPaise: 100,
        previousRefundsPaise: 0,
        previous: NONE,
      }),
    ).toEqual({
      grossReversalPaise: 0,
      commissionReversalPaise: 0,
      amountPaise: 0,
    });
  });
});
