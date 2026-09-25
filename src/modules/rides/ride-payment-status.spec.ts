import { RidePaymentStatus, effectivePaymentStatus } from "./ride-payment-status";

describe("effectivePaymentStatus", () => {
  it("returns the stored status", () => {
    expect(
      effectivePaymentStatus({ status: "COMPLETED", paymentStatus: RidePaymentStatus.SUCCESS, fare: { finalFare: 120 } }),
    ).toBe(RidePaymentStatus.SUCCESS);
    expect(effectivePaymentStatus({ status: "RIDE_STARTED", paymentStatus: RidePaymentStatus.NOT_REQUIRED })).toBe(
      RidePaymentStatus.NOT_REQUIRED,
    );
  });

  it("treats a pre-Phase-4 completed ride with a fare as PENDING", () => {
    expect(effectivePaymentStatus({ status: "COMPLETED", fare: { finalFare: 120 } })).toBe(RidePaymentStatus.PENDING);
    expect(
      effectivePaymentStatus({ status: "COMPLETED", paymentStatus: RidePaymentStatus.NOT_REQUIRED, fare: { finalFare: 80 } }),
    ).toBe(RidePaymentStatus.PENDING);
  });

  it("never asks for payment on cancelled or unpriced rides", () => {
    expect(effectivePaymentStatus({ status: "CANCELLED", fare: { finalFare: 120 } })).toBe(RidePaymentStatus.NOT_REQUIRED);
    expect(effectivePaymentStatus({ status: "COMPLETED", fare: {} })).toBe(RidePaymentStatus.NOT_REQUIRED);
  });
});
