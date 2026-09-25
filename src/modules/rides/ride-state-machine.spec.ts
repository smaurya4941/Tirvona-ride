import {
  ACTIVE_RIDE_STATUSES,
  CUSTOMER_CANCELLABLE_STATUSES,
  DRIVER_CANCELLABLE_STATUSES,
  IllegalRideTransitionError,
  RIDE_TRANSITIONS,
  RideStatus,
  TERMINAL_RIDE_STATUSES,
  assertTransition,
  canTransition,
} from "./ride-state-machine";

const HAPPY_PATH = [
  RideStatus.SEARCHING,
  RideStatus.DRIVER_ASSIGNED,
  RideStatus.DRIVER_ACCEPTED,
  RideStatus.DRIVER_ARRIVED,
  RideStatus.RIDE_STARTED,
  RideStatus.COMPLETED,
];

describe("ride state machine", () => {
  it("allows the full happy path in order", () => {
    for (let index = 0; index < HAPPY_PATH.length - 1; index += 1)
      expect(canTransition(HAPPY_PATH[index], HAPPY_PATH[index + 1])).toBe(true);
  });

  it.each([
    [RideStatus.SEARCHING, RideStatus.COMPLETED],
    [RideStatus.SEARCHING, RideStatus.RIDE_STARTED],
    [RideStatus.DRIVER_ASSIGNED, RideStatus.DRIVER_ARRIVED],
    [RideStatus.DRIVER_ACCEPTED, RideStatus.RIDE_STARTED],
    [RideStatus.COMPLETED, RideStatus.RIDE_STARTED],
    [RideStatus.CANCELLED, RideStatus.DRIVER_ACCEPTED],
    [RideStatus.RIDE_STARTED, RideStatus.CANCELLED],
    [RideStatus.NO_DRIVER_AVAILABLE, RideStatus.SEARCHING],
  ])("rejects %s → %s", (from, to) => {
    expect(canTransition(from, to)).toBe(false);
    expect(() => assertTransition(from, to)).toThrow(IllegalRideTransitionError);
  });

  it("lets a rejected assignment go back to searching", () => {
    expect(canTransition(RideStatus.DRIVER_ASSIGNED, RideStatus.SEARCHING)).toBe(true);
  });

  it("has no way out of a terminal status", () => {
    for (const status of TERMINAL_RIDE_STATUSES) expect(RIDE_TRANSITIONS[status]).toEqual([]);
  });

  it("partitions every status into active or terminal", () => {
    expect([...ACTIVE_RIDE_STATUSES, ...TERMINAL_RIDE_STATUSES].sort()).toEqual(
      Object.values(RideStatus).sort(),
    );
  });

  it("only offers cancellation where the state machine allows it", () => {
    for (const status of [...CUSTOMER_CANCELLABLE_STATUSES, ...DRIVER_CANCELLABLE_STATUSES])
      expect(canTransition(status, RideStatus.CANCELLED)).toBe(true);
    expect(CUSTOMER_CANCELLABLE_STATUSES).not.toContain(RideStatus.RIDE_STARTED);
  });
});
