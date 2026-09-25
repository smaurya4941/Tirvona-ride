/**
 * The UTC instant of local midnight (start of the business day) in
 * `timeZone` for the day containing `now`. Correct for any fixed-offset zone
 * (Asia/Kolkata has no DST) and for DST zones on non-transition days.
 */
export function startOfDayInTimeZone(now: Date, timeZone: string): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((entry) => entry.type === type)?.value);

  const year = part("year");
  const month = part("month") - 1;
  const day = part("day");
  const wallClockAsUtc = Date.UTC(year, month, day, part("hour"), part("minute"), part("second"));
  const offsetMs = wallClockAsUtc - Math.floor(now.getTime() / 1000) * 1000;
  return new Date(Date.UTC(year, month, day) - offsetMs);
}

const DAY_MS = 86_400_000;
// Noon keeps "n days earlier" on the intended calendar day even across a
// DST shift, before snapping back to that day's local midnight.
const NOON_MS = 12 * 3_600_000;

function localDate(now: Date, timeZone: string): { day: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, day: "numeric", weekday: "short" }).formatToParts(now);
  const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  return {
    day: Number(parts.find((part) => part.type === "day")?.value),
    weekday: weekdays.indexOf(parts.find((part) => part.type === "weekday")?.value ?? "Mon"),
  };
}

/** Local midnight at the start of the current ISO week (Monday) in `timeZone`. */
export function startOfWeekInTimeZone(now: Date, timeZone: string): Date {
  const today = startOfDayInTimeZone(now, timeZone);
  const { weekday } = localDate(now, timeZone);
  return startOfDayInTimeZone(new Date(today.getTime() - weekday * DAY_MS + NOON_MS), timeZone);
}

/** Local midnight on the 1st of the current month in `timeZone`. */
export function startOfMonthInTimeZone(now: Date, timeZone: string): Date {
  const today = startOfDayInTimeZone(now, timeZone);
  const { day } = localDate(now, timeZone);
  return startOfDayInTimeZone(new Date(today.getTime() - (day - 1) * DAY_MS + NOON_MS), timeZone);
}
