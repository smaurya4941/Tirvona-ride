import type { PricingRates } from "./fare-calculator";

/**
 * Peak-hour pricing rules (docs/pricing/peak-pricing.md). Everything here is
 * pure so the whole rule set, including cross-midnight slots and the
 * start-inclusive / end-exclusive boundaries, is unit-tested without a
 * database.
 *
 * A slot is a daily window in the business time zone (APP_TIME_ZONE):
 *   [start, end)            when start < end   (16:00 → 20:00)
 *   [start, 24:00) ∪ [0, end) when start > end (22:00 → 02:00, crosses midnight)
 * start === end is rejected: it is neither "never" nor "all day".
 */

export const MINUTES_PER_DAY = 1440;

export const TIME_OF_DAY_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** The slice of a stored slot the rules need. */
export interface PeakWindow {
  startTime: string;
  endTime: string;
}

export interface PeakScope {
  appliesToAll: boolean;
  rideTypes: readonly string[];
}

export interface PeakRule extends PeakWindow, PeakScope {
  id: string;
  name: string;
  hikePercent: number;
}

/** The peak a priced trip carries (and the ride snapshots). */
export interface AppliedPeak {
  slotId: string;
  name: string;
  hikePercent: number;
  startTime: string;
  endTime: string;
  /** Extra distance charge caused by the peak, rupees (peak − normal rate over the same distance). */
  surcharge: number;
}

export function parseTimeOfDay(value: string): number {
  const match = TIME_OF_DAY_PATTERN.exec(value);
  if (!match) throw new RangeError(`"${value}" is not a time of day (HH:mm, 24-hour)`);
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Minutes since local midnight of `at` in `timeZone`. */
export function minuteOfDay(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((entry) => entry.type === type)?.value);
  return part("hour") * 60 + part("minute");
}

export const crossesMidnight = (window: PeakWindow): boolean =>
  parseTimeOfDay(window.startTime) > parseTimeOfDay(window.endTime);

/** Start inclusive, end exclusive; handles windows that cross midnight. */
export function windowContains(window: PeakWindow, minute: number): boolean {
  const start = parseTimeOfDay(window.startTime);
  const end = parseTimeOfDay(window.endTime);
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

/** The window as one or two [start, end) segments inside a single day. */
function segments(window: PeakWindow): Array<[number, number]> {
  const start = parseTimeOfDay(window.startTime);
  const end = parseTimeOfDay(window.endTime);
  return start < end
    ? [[start, end]]
    : [
        [start, MINUTES_PER_DAY],
        [0, end],
      ];
}

export function windowsOverlap(a: PeakWindow, b: PeakWindow): boolean {
  return segments(a).some(([aStart, aEnd]) => segments(b).some(([bStart, bEnd]) => aStart < bEnd && bStart < aEnd));
}

/** Two scopes share a ride type when either is "all" or their code lists intersect. */
export function scopesIntersect(a: PeakScope, b: PeakScope): boolean {
  if (a.appliesToAll || b.appliesToAll) return true;
  return a.rideTypes.some((code) => b.rideTypes.includes(code));
}

export const appliesToRideType = (scope: PeakScope, rideType: string): boolean =>
  scope.appliesToAll || scope.rideTypes.includes(rideType);

/**
 * The first rule that is in force for `rideType` at `minute`. Active rules
 * never overlap for a ride type (checked when they are saved), so "first" is
 * only a tie-break for data that predates a rule change.
 */
export function resolvePeak<T extends PeakRule>(rules: readonly T[], rideType: string, minute: number): T | undefined {
  return rules.find((rule) => appliesToRideType(rule, rideType) && windowContains(rule, minute));
}

const toPaise = (rupees: number): number => Math.round(rupees * 100);

/**
 * The per-km rate with the hike applied, rounded to the paisa
 * (₹18 + 50% = ₹27, ₹14 + 12.5% = ₹15.75). Only the per-km rate moves.
 */
export function effectivePerKmRate(perKmRate: number, hikePercent: number): number {
  const hikeBasisPoints = Math.round(hikePercent * 100);
  return Math.round((toPaise(perKmRate) * (10_000 + hikeBasisPoints)) / 10_000) / 100;
}

/** Base rates with the peak hike applied to per-km only; every other rate is untouched. */
export function peakRates<R extends PricingRates>(rates: R, hikePercent: number): R {
  return { ...rates, perKmRate: effectivePerKmRate(rates.perKmRate, hikePercent) };
}

/** Two active slots would both claim some minute for some ride type. */
export function findConflict<T extends PeakRule>(candidate: PeakRule, existing: readonly T[]): T | undefined {
  return existing.find(
    (other) => other.id !== candidate.id && windowsOverlap(candidate, other) && scopesIntersect(candidate, other),
  );
}

/** "16:00" → "4:00 PM" for messages. */
export function formatTimeOfDay(value: string): string {
  const minutes = parseTimeOfDay(value);
  const hour = Math.floor(minutes / 60);
  const suffix = hour >= 12 ? "PM" : "AM";
  return `${hour % 12 === 0 ? 12 : hour % 12}:${String(minutes % 60).padStart(2, "0")} ${suffix}`;
}
