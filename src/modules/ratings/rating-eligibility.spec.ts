import { RidePaymentStatus } from "../rides/ride-payment-status";
import { RideStatus } from "../rides/ride-state-machine";
import { RatingBlocker, ratingEligibility } from "./rating-eligibility";

const completedAt = new Date("2026-09-20T10:00:00Z");
const paidRide = {
  status: RideStatus.COMPLETED,
  paymentStatus: RidePaymentStatus.SUCCESS,
  fare: { finalFare: 125 },
  driverId: "d1",
  completedAt,
};
const now = new Date("2026-09-21T10:00:00Z");

describe("ratingEligibility", () => {
  it("allows a completed, paid ride inside the window", () => {
    expect(ratingEligibility(paidRide, false, 30, now)).toEqual({
      canRate: true,
      windowEndsAt: new Date("2026-10-20T10:00:00Z"),
    });
  });

  it("a refund afterwards does not take the right to rate away", () => {
    for (const paymentStatus of [RidePaymentStatus.REFUNDED, RidePaymentStatus.PARTIALLY_REFUNDED])
      expect(ratingEligibility({ ...paidRide, paymentStatus }, false, 30, now).canRate).toBe(true);
  });

  it.each([
    [RidePaymentStatus.PENDING],
    [RidePaymentStatus.ORDER_CREATED],
    [RidePaymentStatus.PROCESSING],
    [RidePaymentStatus.FAILED],
    [RidePaymentStatus.NOT_REQUIRED],
  ])("rejects an unpaid ride (%s)", (paymentStatus) => {
    expect(ratingEligibility({ ...paidRide, paymentStatus }, false, 30, now).reason).toBe(
      RatingBlocker.PAYMENT_NOT_VERIFIED,
    );
  });

  it.each([RideStatus.CANCELLED, RideStatus.RIDE_STARTED, RideStatus.SEARCHING, RideStatus.NO_DRIVER_AVAILABLE])(
    "rejects a ride that is %s",
    (status) => {
      expect(ratingEligibility({ ...paidRide, status }, false, 30, now).reason).toBe(RatingBlocker.RIDE_NOT_COMPLETED);
    },
  );

  it("rejects a second rating before anything else", () => {
    expect(ratingEligibility(paidRide, true, 30, now).reason).toBe(RatingBlocker.ALREADY_RATED);
  });

  it("closes after the window", () => {
    expect(ratingEligibility(paidRide, false, 1, new Date("2026-09-22T10:00:01Z")).reason).toBe(
      RatingBlocker.WINDOW_CLOSED,
    );
  });

  it("needs a driver", () => {
    expect(ratingEligibility({ ...paidRide, driverId: undefined }, false, 30, now).reason).toBe(RatingBlocker.NO_DRIVER);
  });
});
