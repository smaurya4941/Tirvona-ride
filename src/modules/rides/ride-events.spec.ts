import { RideEvent } from "../realtime/realtime.constants";
import { inRideRoom, planRideEvents } from "./ride-events";
import { RideStatus } from "./ride-state-machine";

describe("planRideEvents", () => {
  it.each([
    [undefined, RideStatus.SEARCHING, RideEvent.REQUESTED, undefined, undefined],
    [RideStatus.SEARCHING, RideStatus.DRIVER_ASSIGNED, RideEvent.DRIVER_ASSIGNED, RideEvent.REQUESTED, undefined],
    [RideStatus.DRIVER_ASSIGNED, RideStatus.SEARCHING, RideEvent.SEARCHING, undefined, RideEvent.OFFER_WITHDRAWN],
    [RideStatus.DRIVER_ASSIGNED, RideStatus.DRIVER_ACCEPTED, RideEvent.DRIVER_ACCEPTED, RideEvent.DRIVER_ACCEPTED, undefined],
    [RideStatus.DRIVER_ACCEPTED, RideStatus.DRIVER_ARRIVED, RideEvent.DRIVER_ARRIVED, RideEvent.DRIVER_ARRIVED, undefined],
    [RideStatus.DRIVER_ARRIVED, RideStatus.RIDE_STARTED, RideEvent.STARTED, RideEvent.STARTED, undefined],
    [RideStatus.RIDE_STARTED, RideStatus.COMPLETED, RideEvent.COMPLETED, RideEvent.COMPLETED, undefined],
    [RideStatus.DRIVER_ASSIGNED, RideStatus.CANCELLED, RideEvent.CANCELLED, RideEvent.CANCELLED, undefined],
    [RideStatus.SEARCHING, RideStatus.NO_DRIVER_AVAILABLE, RideEvent.NO_DRIVER_AVAILABLE, undefined, undefined],
  ])("%s → %s", (from, to, customer, driver, previousDriver) => {
    const plan = planRideEvents(from, to);
    expect(plan.customer).toBe(customer);
    expect(plan.driver).toBe(driver);
    expect(plan.previousDriver).toBe(previousDriver);
  });

  it("closes the ride room exactly on terminal statuses", () => {
    for (const status of Object.values(RideStatus))
      expect(planRideEvents(undefined, status).closeRoom).toBe(
        [RideStatus.COMPLETED, RideStatus.CANCELLED, RideStatus.NO_DRIVER_AVAILABLE].includes(status),
      );
  });
});

describe("inRideRoom", () => {
  it("keeps the customer in while active and the driver only once committed", () => {
    expect(inRideRoom(RideStatus.SEARCHING, "customer")).toBe(true);
    expect(inRideRoom(RideStatus.DRIVER_ASSIGNED, "driver")).toBe(false);
    expect(inRideRoom(RideStatus.DRIVER_ACCEPTED, "driver")).toBe(true);
    expect(inRideRoom(RideStatus.RIDE_STARTED, "driver")).toBe(true);
    expect(inRideRoom(RideStatus.COMPLETED, "customer")).toBe(false);
    expect(inRideRoom(RideStatus.CANCELLED, "driver")).toBe(false);
  });
});
