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

  // ── Phase 7: exhaustive coverage of the transition table ────────────────

  const ALLOWED = new Set<string>([
    `${RideStatus.SEARCHING}>${RideStatus.DRIVER_ASSIGNED}`,
    `${RideStatus.SEARCHING}>${RideStatus.CANCELLED}`,
    `${RideStatus.SEARCHING}>${RideStatus.NO_DRIVER_AVAILABLE}`,
    `${RideStatus.DRIVER_ASSIGNED}>${RideStatus.DRIVER_ACCEPTED}`,
    `${RideStatus.DRIVER_ASSIGNED}>${RideStatus.SEARCHING}`,
    `${RideStatus.DRIVER_ASSIGNED}>${RideStatus.CANCELLED}`,
    `${RideStatus.DRIVER_ACCEPTED}>${RideStatus.DRIVER_ARRIVED}`,
    `${RideStatus.DRIVER_ACCEPTED}>${RideStatus.CANCELLED}`,
    `${RideStatus.DRIVER_ARRIVED}>${RideStatus.RIDE_STARTED}`,
    `${RideStatus.DRIVER_ARRIVED}>${RideStatus.CANCELLED}`,
    `${RideStatus.RIDE_STARTED}>${RideStatus.COMPLETED}`,
  ]);
  const ALL_PAIRS = Object.values(RideStatus).flatMap((from) => Object.values(RideStatus).map((to) => [from, to] as const));

  it.each(ALL_PAIRS)("%s → %s matches the locked transition table", (from, to) => {
    expect(canTransition(from, to)).toBe(ALLOWED.has(`${from}>${to}`));
  });

  it.each([
    ["complete a ride that was only requested", RideStatus.SEARCHING, RideStatus.COMPLETED],
    ["start a completed ride", RideStatus.COMPLETED, RideStatus.RIDE_STARTED],
    ["cancel a completed ride", RideStatus.COMPLETED, RideStatus.CANCELLED],
    ["start a cancelled ride", RideStatus.CANCELLED, RideStatus.RIDE_STARTED],
    ["complete a cancelled ride", RideStatus.CANCELLED, RideStatus.COMPLETED],
    ["cancel an already cancelled ride", RideStatus.CANCELLED, RideStatus.CANCELLED],
    ["cancel a ride in progress", RideStatus.RIDE_STARTED, RideStatus.CANCELLED],
    ["revive an unmatched ride", RideStatus.NO_DRIVER_AVAILABLE, RideStatus.DRIVER_ASSIGNED],
  ])("refuses to %s", (_label, from, to) => {
    expect(() => assertTransition(from, to)).toThrow(`Illegal ride transition ${from} → ${to}`);
  });

  it("never lets a driver cancel before accepting (they reject instead)", () => {
    expect(DRIVER_CANCELLABLE_STATUSES).not.toContain(RideStatus.SEARCHING);
    expect(DRIVER_CANCELLABLE_STATUSES).not.toContain(RideStatus.DRIVER_ASSIGNED);
    expect(DRIVER_CANCELLABLE_STATUSES).not.toContain(RideStatus.RIDE_STARTED);
  });
});
