import { startOfDayInTimeZone } from "../../common/utils/time";

export enum ReportPreset {
  TODAY = "TODAY",
  YESTERDAY = "YESTERDAY",
  LAST_7_DAYS = "LAST_7_DAYS",
  LAST_30_DAYS = "LAST_30_DAYS",
  CUSTOM = "CUSTOM",
}

export interface ReportRange {
  preset: ReportPreset;
  /** Inclusive start: local midnight of the first day. */
  from: Date;
  /** Exclusive end: local midnight after the last day (or "now" for today). */
  to: Date;
  /** Local calendar days covered, "YYYY-MM-DD", oldest first. */
  days: string[];
  timeZone: string;
}

export class ReportRangeError extends Error {}

const DAY_MS = 86_400_000;
const NOON_MS = 12 * 3_600_000;
export const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** "YYYY-MM-DD" of `date` in `timeZone`. */
export function localDay(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

/** Local midnight of a "YYYY-MM-DD" day (noon UTC lands on that day for UTC−11…UTC+11). */
function midnightOf(day: string, timeZone: string): Date {
  const noon = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(noon.getTime()) || localDay(noon, timeZone) !== day) throw new ReportRangeError(`Invalid date ${day}`);
  return startOfDayInTimeZone(noon, timeZone);
}

const nextMidnight = (midnight: Date, timeZone: string): Date =>
  startOfDayInTimeZone(new Date(midnight.getTime() + DAY_MS + NOON_MS), timeZone);

/**
 * Turns a preset or a custom pair of local dates (both inclusive) into the
 * [from, to) instants every report aggregates over, in the business time
 * zone. Pure, so date edge cases are unit-tested.
 */
export function resolveReportRange(
  input: { preset?: ReportPreset; from?: string; to?: string },
  now: Date,
  timeZone: string,
  maxDays: number,
): ReportRange {
  const preset = input.preset ?? (input.from || input.to ? ReportPreset.CUSTOM : ReportPreset.LAST_7_DAYS);
  const today = startOfDayInTimeZone(now, timeZone);
  const tomorrow = nextMidnight(today, timeZone);
  const daysBack = (count: number): Date => startOfDayInTimeZone(new Date(today.getTime() - count * DAY_MS + NOON_MS), timeZone);

  let from: Date;
  let to: Date;
  switch (preset) {
    case ReportPreset.TODAY:
      [from, to] = [today, tomorrow];
      break;
    case ReportPreset.YESTERDAY:
      [from, to] = [daysBack(1), today];
      break;
    case ReportPreset.LAST_7_DAYS:
      [from, to] = [daysBack(6), tomorrow];
      break;
    case ReportPreset.LAST_30_DAYS:
      [from, to] = [daysBack(29), tomorrow];
      break;
    case ReportPreset.CUSTOM: {
      if (!input.from || !input.to || !LOCAL_DATE.test(input.from) || !LOCAL_DATE.test(input.to))
        throw new ReportRangeError("A custom range needs from and to dates (YYYY-MM-DD)");
      from = midnightOf(input.from, timeZone);
      to = nextMidnight(midnightOf(input.to, timeZone), timeZone);
      if (to <= from) throw new ReportRangeError("The end date must not be before the start date");
      if (from >= tomorrow) throw new ReportRangeError("The range cannot start in the future");
      break;
    }
  }

  const days: string[] = [];
  for (let cursor = from; cursor < to; cursor = nextMidnight(cursor, timeZone)) {
    days.push(localDay(cursor, timeZone));
    if (days.length > maxDays) throw new ReportRangeError(`A report can cover at most ${maxDays} days`);
  }
  return { preset, from, to, days, timeZone };
}

/** Fills a sparse per-day aggregation into one row per day of the range. */
export function fillDays<T extends Record<string, number>>(
  days: string[],
  rows: Array<{ _id: string } & Partial<T>>,
  empty: T,
): Array<{ date: string } & T> {
  const byDay = new Map(rows.map((row) => [row._id, row]));
  return days.map((date) => {
    const row = byDay.get(date);
    const filled = { ...empty } as T;
    if (row) for (const key of Object.keys(empty) as Array<keyof T>) filled[key] = (row[key] ?? empty[key]) as T[keyof T];
    return { date, ...filled };
  });
}

export const ratio = (part: number, whole: number): number => (whole > 0 ? Math.round((part / whole) * 10_000) / 100 : 0);
export const round2 = (value: number): number => Math.round(value * 100) / 100;
