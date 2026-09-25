import { startOfDayInTimeZone, startOfMonthInTimeZone, startOfWeekInTimeZone } from "./time";

const IST = "Asia/Kolkata";

describe("business-period boundaries (Asia/Kolkata)", () => {
  // Thursday 24 Sep 2026, 15:30 IST.
  const now = new Date("2026-09-24T10:00:00Z");

  it("day starts at local midnight", () => {
    expect(startOfDayInTimeZone(now, IST).toISOString()).toBe("2026-09-23T18:30:00.000Z");
  });

  it("week starts on Monday at local midnight", () => {
    expect(startOfWeekInTimeZone(now, IST).toISOString()).toBe("2026-09-20T18:30:00.000Z");
  });

  it("a Monday is its own week start; a Sunday belongs to the week before", () => {
    const monday = new Date("2026-09-21T02:00:00Z"); // 07:30 IST Monday
    expect(startOfWeekInTimeZone(monday, IST).toISOString()).toBe("2026-09-20T18:30:00.000Z");
    const sunday = new Date("2026-09-27T17:00:00Z"); // 22:30 IST Sunday
    expect(startOfWeekInTimeZone(sunday, IST).toISOString()).toBe("2026-09-20T18:30:00.000Z");
  });

  it("uses the local date, not the UTC date, near midnight", () => {
    const earlyMondayIst = new Date("2026-09-20T19:00:00Z"); // 00:30 IST Monday, still Sunday in UTC
    expect(startOfWeekInTimeZone(earlyMondayIst, IST).toISOString()).toBe("2026-09-20T18:30:00.000Z");
  });

  it("month starts on the 1st at local midnight", () => {
    expect(startOfMonthInTimeZone(now, IST).toISOString()).toBe("2026-08-31T18:30:00.000Z");
    const firstOfMonth = new Date("2026-10-01T00:00:00Z"); // 05:30 IST 1 Oct
    expect(startOfMonthInTimeZone(firstOfMonth, IST).toISOString()).toBe("2026-09-30T18:30:00.000Z");
  });
});
