import { DriverLiveLocationStore } from "./driver-live-location.store";

describe("DriverLiveLocationStore", () => {
  it("rate limits fixes per driver", () => {
    const store = new DriverLiveLocationStore();
    expect(store.tryAccept("d1", 1000, 10_000)).toBe(true);
    expect(store.tryAccept("d1", 1000, 10_500)).toBe(false);
    expect(store.tryAccept("d2", 1000, 10_500)).toBe(true);
    expect(store.tryAccept("d1", 1000, 11_000)).toBe(true);
  });

  it("spaces trail checkpoints and resets between rides", () => {
    const store = new DriverLiveLocationStore();
    expect(store.checkpointDue("d1", 60_000, 0)).toBe(true);
    expect(store.checkpointDue("d1", 60_000, 30_000)).toBe(false);
    expect(store.checkpointDue("d1", 60_000, 60_000)).toBe(true);
    store.resetCheckpointClock("d1");
    expect(store.checkpointDue("d1", 60_000, 60_001)).toBe(true);
  });

  it("returns the latest fix only while fresh", () => {
    const store = new DriverLiveLocationStore();
    const receivedAt = new Date(Date.now() - 5_000);
    store.save("d1", { latitude: 27.5, longitude: 77.6, recordedAt: receivedAt, receivedAt });
    expect(store.latest("d1")?.latitude).toBe(27.5);
    expect(store.latest("d1", 10_000)).toBeDefined();
    expect(store.latest("d1", 1_000)).toBeUndefined();
    store.forget("d1");
    expect(store.latest("d1")).toBeUndefined();
  });
});
