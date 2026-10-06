import {
  ReportPreset,
  ReportRangeError,
  fillDays,
  ratio,
  resolveReportRange,
} from "./report-range";

const TZ = "Asia/Kolkata";
// 26 Sep 2026, 15:30 IST.
const NOW = new Date("2026-09-26T10:00:00Z");

describe("resolveReportRange", () => {
  it("TODAY is local midnight to the next local midnight", () => {
    const range = resolveReportRange(
      { preset: ReportPreset.TODAY },
      NOW,
      TZ,
      366,
    );
    expect(range.from.toISOString()).toBe("2026-09-25T18:30:00.000Z");
    expect(range.to.toISOString()).toBe("2026-09-26T18:30:00.000Z");
    expect(range.days).toEqual(["2026-09-26"]);
  });

  it("YESTERDAY ends where today starts", () => {
    const range = resolveReportRange(
      { preset: ReportPreset.YESTERDAY },
      NOW,
      TZ,
      366,
    );
    expect(range.days).toEqual(["2026-09-25"]);
    expect(range.to.toISOString()).toBe("2026-09-25T18:30:00.000Z");
  });

  it("LAST_7_DAYS includes today and six days before it", () => {
    const range = resolveReportRange(
      { preset: ReportPreset.LAST_7_DAYS },
      NOW,
      TZ,
      366,
    );
    expect(range.days).toEqual([
      "2026-09-20",
      "2026-09-21",
      "2026-09-22",
      "2026-09-23",
      "2026-09-24",
      "2026-09-25",
      "2026-09-26",
    ]);
  });

  it("LAST_30_DAYS covers 30 local days", () => {
    expect(
      resolveReportRange({ preset: ReportPreset.LAST_30_DAYS }, NOW, TZ, 366)
        .days,
    ).toHaveLength(30);
  });

  it("defaults to LAST_7_DAYS, and to CUSTOM when dates are given", () => {
    expect(resolveReportRange({}, NOW, TZ, 366).preset).toBe(
      ReportPreset.LAST_7_DAYS,
    );
    expect(
      resolveReportRange({ from: "2026-09-01", to: "2026-09-03" }, NOW, TZ, 366)
        .preset,
    ).toBe(ReportPreset.CUSTOM);
  });

  it("treats both custom dates as inclusive local days", () => {
    const range = resolveReportRange(
      { from: "2026-09-01", to: "2026-09-03" },
      NOW,
      TZ,
      366,
    );
    expect(range.days).toEqual(["2026-09-01", "2026-09-02", "2026-09-03"]);
    expect(range.from.toISOString()).toBe("2026-08-31T18:30:00.000Z");
    expect(range.to.toISOString()).toBe("2026-09-03T18:30:00.000Z");
  });

  it.each([
    [{ preset: ReportPreset.CUSTOM }, "needs from and to"],
    [{ from: "2026-09-05", to: "2026-09-01" }, "must not be before"],
    [{ from: "2026-02-30", to: "2026-03-01" }, "Invalid date"],
    [{ from: "2026-10-01", to: "2026-10-02" }, "cannot start in the future"],
    [{ from: "2024-01-01", to: "2026-09-01" }, "at most 366 days"],
  ])("rejects %j", (input, message) => {
    expect(() => resolveReportRange(input, NOW, TZ, 366)).toThrow(
      ReportRangeError,
    );
    expect(() => resolveReportRange(input, NOW, TZ, 366)).toThrow(message);
  });
});

describe("fillDays / ratio", () => {
  it("fills missing days with zeros in order", () => {
    expect(
      fillDays(
        ["2026-09-01", "2026-09-02"],
        [{ _id: "2026-09-02", rides: 3 }],
        { rides: 0 },
      ),
    ).toEqual([
      { date: "2026-09-01", rides: 0 },
      { date: "2026-09-02", rides: 3 },
    ]);
  });

  it("computes percentages safely", () => {
    expect(ratio(1, 3)).toBe(33.33);
    expect(ratio(5, 0)).toBe(0);
  });
});
