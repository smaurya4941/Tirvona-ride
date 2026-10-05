import { CircuitStopStatus, STOP_COMMANDS, activeStop, allStopsDone, isStopDone } from "./circuit-ride.types";

const stops = (...statuses: CircuitStopStatus[]) => statuses.map((status, index) => ({ order: index + 1, status }));

describe("circuit stop progression", () => {
  const { UPCOMING, ARRIVING, ARRIVED, WAITING, COMPLETED, SKIPPED } = CircuitStopStatus;

  it("the active stop is the first one not done, whatever order they are stored in", () => {
    expect(activeStop(stops(COMPLETED, ARRIVING, UPCOMING))?.order).toBe(2);
    expect(activeStop([...stops(COMPLETED, ARRIVING, UPCOMING)].reverse())?.order).toBe(2);
    expect(activeStop(stops(COMPLETED, SKIPPED, ARRIVING))?.order).toBe(3);
    expect(activeStop(stops(COMPLETED, COMPLETED))).toBeUndefined();
  });

  it("completed and skipped stops are done; nothing else is", () => {
    expect([UPCOMING, ARRIVING, ARRIVED, WAITING].some(isStopDone)).toBe(false);
    expect(isStopDone(COMPLETED) && isStopDone(SKIPPED)).toBe(true);
  });

  it("a circuit is finished only when every stop is done", () => {
    expect(allStopsDone(stops(COMPLETED, SKIPPED))).toBe(true);
    expect(allStopsDone(stops(COMPLETED, ARRIVED))).toBe(false);
    expect(allStopsDone([])).toBe(false);
  });

  it("a stop can only be completed after the driver arrived, never straight from the road", () => {
    expect((STOP_COMMANDS.COMPLETE.from as readonly CircuitStopStatus[]).includes(ARRIVING)).toBe(false);
    expect((STOP_COMMANDS.COMPLETE.from as readonly CircuitStopStatus[]).includes(ARRIVED)).toBe(true);
    expect((STOP_COMMANDS.COMPLETE.from as readonly CircuitStopStatus[]).includes(WAITING)).toBe(true);
    expect(STOP_COMMANDS.ARRIVE.from).toEqual([ARRIVING]);
  });
});
