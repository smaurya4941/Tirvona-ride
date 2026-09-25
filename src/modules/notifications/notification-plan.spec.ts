import type { RideSnapshot } from "../../infrastructure/events/domain-events";
import { RidePaymentStatus } from "../rides/ride-payment-status";
import { RideActorType, RideStatus } from "../rides/ride-state-machine";
import {
  formatRupees,
  planArrivingNotification,
  planPaymentNotifications,
  planRideNotifications,
} from "./notification-plan";
import { NotificationType } from "./notification-types";

const ride = (overrides: Partial<RideSnapshot> = {}): RideSnapshot => ({
  rideId: "r1",
  rideCode: "TR2345ABCD",
  status: RideStatus.SEARCHING,
  stateVersion: 3,
  customerId: "c1",
  driverId: "d1",
  driverUserId: "du1",
  pickupAddress: "Prem Mandir, Vrindavan",
  destinationAddress: "Banke Bihari Temple, Vrindavan",
  finalFare: 125,
  estimatedFare: 120,
  currency: "INR",
  ...overrides,
});

const plan = (to: RideStatus, from?: RideStatus, overrides: Partial<RideSnapshot> = {}) =>
  planRideNotifications({ ride: ride({ status: to, ...overrides }), from, to }, { driverName: "Rahul", vehiclePlate: "UP85CC0001" });

const who = (drafts: ReturnType<typeof plan>) => drafts.map((draft) => `${draft.userId}:${draft.type}`);

describe("planRideNotifications (the ride notification matrix)", () => {
  it("is silent while searching (booking and re-matching)", () => {
    expect(plan(RideStatus.SEARCHING, undefined, { driverUserId: undefined })).toEqual([]);
    expect(plan(RideStatus.SEARCHING, RideStatus.DRIVER_ASSIGNED)).toEqual([]);
  });

  it("assigned: customer hears 'driver found', the driver gets the request", () => {
    expect(who(plan(RideStatus.DRIVER_ASSIGNED, RideStatus.SEARCHING))).toEqual([
      "c1:RIDE_DRIVER_ASSIGNED",
      "du1:RIDE_REQUEST",
    ]);
  });

  it.each([
    [RideStatus.DRIVER_ACCEPTED, ["c1:RIDE_DRIVER_ACCEPTED"]],
    [RideStatus.DRIVER_ARRIVED, ["c1:RIDE_DRIVER_ARRIVED"]],
    [RideStatus.RIDE_STARTED, ["c1:RIDE_STARTED", "du1:RIDE_STARTED"]],
    [RideStatus.COMPLETED, ["c1:RIDE_COMPLETED", "du1:RIDE_COMPLETED"]],
  ])("%s → %j", (to, expected) => {
    expect(who(plan(to))).toEqual(expected);
  });

  it("names the driver and the plate so the customer can find the vehicle", () => {
    const [arrived] = plan(RideStatus.DRIVER_ARRIVED);
    expect(arrived.message).toContain("Rahul (UP85CC0001)");
    expect(arrived.data).toEqual({ rideId: "r1", rideCode: "TR2345ABCD" });
  });

  it("never notifies the person who cancelled", () => {
    const byCustomer = plan(RideStatus.CANCELLED, RideStatus.DRIVER_ACCEPTED, { cancelledBy: RideActorType.CUSTOMER });
    expect(who(byCustomer)).toEqual(["du1:RIDE_CANCELLED"]);
    const byDriver = plan(RideStatus.CANCELLED, RideStatus.DRIVER_ACCEPTED, { cancelledBy: RideActorType.DRIVER });
    expect(who(byDriver)).toEqual(["c1:RIDE_CANCELLED"]);
    const byAdmin = plan(RideStatus.CANCELLED, RideStatus.DRIVER_ACCEPTED, { cancelledBy: RideActorType.ADMIN });
    expect(who(byAdmin)).toEqual(["c1:RIDE_CANCELLED", "du1:RIDE_CANCELLED"]);
  });

  it("tells the customer when nobody was found", () => {
    expect(who(plan(RideStatus.NO_DRIVER_AVAILABLE, RideStatus.SEARCHING, { driverUserId: undefined }))).toEqual([
      "c1:RIDE_NO_DRIVER",
    ]);
  });

  it("dedupe keys are unique per recipient and per committed state", () => {
    const drafts = plan(RideStatus.RIDE_STARTED);
    expect(new Set(drafts.map((draft) => draft.dedupeKey)).size).toBe(2);
    expect(drafts[0].dedupeKey).toBe("ride:r1:RIDE_STARTED:v3:c1");
    const later = planRideNotifications({ ride: ride({ stateVersion: 4 }), to: RideStatus.RIDE_STARTED });
    expect(later[0].dedupeKey).not.toBe(drafts[0].dedupeKey);
  });
});

describe("planArrivingNotification", () => {
  it("rounds the ETA to whole minutes, at least 1", () => {
    expect(planArrivingNotification(ride(), 150, { driverName: "Rahul" }).message).toContain("about 3 min");
    expect(planArrivingNotification(ride(), 10).message).toContain("about 1 min");
    expect(planArrivingNotification(ride(), undefined).message).toContain("almost");
    expect(planArrivingNotification(ride(), 60).type).toBe(NotificationType.RIDE_DRIVER_ARRIVING);
  });
});

describe("planPaymentNotifications", () => {
  it("success: customer confirmation + driver 'payment received'", () => {
    const drafts = planPaymentNotifications(ride(), RidePaymentStatus.SUCCESS, 125);
    expect(drafts.map((draft) => `${draft.userId}:${draft.type}`)).toEqual([
      "c1:PAYMENT_SUCCESS",
      "du1:PAYMENT_RECEIVED",
    ]);
    expect(drafts[0].message).toContain("₹125");
  });

  it("failure: only the customer, with a retry prompt", () => {
    const drafts = planPaymentNotifications(ride(), RidePaymentStatus.FAILED, 125.5);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].type).toBe(NotificationType.PAYMENT_FAILED);
    expect(drafts[0].message).toContain("₹125.50");
  });

  it("in-between states produce nothing", () => {
    for (const status of [RidePaymentStatus.ORDER_CREATED, RidePaymentStatus.PROCESSING, RidePaymentStatus.PENDING])
      expect(planPaymentNotifications(ride(), status)).toEqual([]);
  });
});

describe("formatRupees", () => {
  it("formats whole and fractional rupees", () => {
    expect(formatRupees(125)).toBe("₹125");
    expect(formatRupees(52.5)).toBe("₹52.50");
    expect(formatRupees(undefined)).toBe("");
  });
});
