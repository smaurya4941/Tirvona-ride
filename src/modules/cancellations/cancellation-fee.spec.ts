import { RideActorType, RideStatus } from "../rides/ride-state-machine";
import {
  DISABLED_CUSTOMER_FEE_RULE,
  assessCancellationFee,
} from "./cancellation-fee";
import type { CustomerFeeRule } from "./cancellation-fee";

const ACCEPTED_AT = new Date("2026-09-26T10:00:00Z");
const after = (seconds: number) =>
  new Date(ACCEPTED_AT.getTime() + seconds * 1000);

const RULE: CustomerFeeRule = {
  enabled: true,
  graceSeconds: 120,
  fixedFee: 10,
  percentOfFare: 10,
  maxFee: 50,
  applicableStatuses: [RideStatus.DRIVER_ACCEPTED, RideStatus.DRIVER_ARRIVED],
};

const assess = (
  overrides: Partial<Parameters<typeof assessCancellationFee>[1]> = {},
  rule = RULE,
) =>
  assessCancellationFee(rule, {
    actor: RideActorType.CUSTOMER,
    status: RideStatus.DRIVER_ACCEPTED,
    acceptedAt: ACCEPTED_AT,
    now: after(300),
    fare: 150,
    ...overrides,
  });

describe("assessCancellationFee", () => {
  it("charges nothing while the seeded (disabled) policy is in force", () => {
    expect(assess({}, DISABLED_CUSTOMER_FEE_RULE)).toMatchObject({
      amount: 0,
      applies: false,
    });
  });

  it("charges fixed + percentage of the booked fare after the grace period", () => {
    // 10 + 10% of 150 = 25
    expect(assess()).toMatchObject({ amount: 25, applies: true });
  });

  it("is free inside the grace period and says until when", () => {
    const result = assess({ now: after(119) });
    expect(result).toMatchObject({ amount: 0, applies: false });
    expect(result.freeUntil).toEqual(after(120));
  });

  it("starts charging exactly at the end of the grace period", () => {
    expect(assess({ now: after(120) }).applies).toBe(true);
  });

  it("caps the fee at maxFee", () => {
    expect(assess({ fare: 2_000 }).amount).toBe(50);
  });

  it("never charges more than the fare itself", () => {
    expect(
      assess({ fare: 8 }, { ...RULE, maxFee: 0, fixedFee: 40 }).amount,
    ).toBe(8);
  });

  it.each([RideStatus.SEARCHING, RideStatus.DRIVER_ASSIGNED])(
    "is free before a driver commits (%s)",
    (status) => {
      expect(assess({ status, acceptedAt: undefined })).toMatchObject({
        amount: 0,
        applies: false,
      });
    },
  );

  it("applies after arrival when the policy includes DRIVER_ARRIVED", () => {
    expect(assess({ status: RideStatus.DRIVER_ARRIVED }).applies).toBe(true);
  });

  it("respects a policy limited to arrival only", () => {
    const arrivalOnly = {
      ...RULE,
      applicableStatuses: [RideStatus.DRIVER_ARRIVED],
    };
    expect(
      assess({ status: RideStatus.DRIVER_ACCEPTED }, arrivalOnly).applies,
    ).toBe(false);
  });

  it.each([RideActorType.DRIVER, RideActorType.ADMIN, RideActorType.SYSTEM])(
    "never charges when %s cancels",
    (actor) => {
      expect(assess({ actor })).toMatchObject({ amount: 0, applies: false });
    },
  );

  it("is deterministic", () => {
    expect(assess()).toEqual(assess());
  });
});
