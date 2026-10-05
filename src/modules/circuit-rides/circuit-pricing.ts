/**
 * Circuit fare = package price + what the trip used beyond the package.
 *
 *   extra distance = started km above the included distance × rate per km
 *   extra time     = started 15-minute blocks above the included time × (rate per hour / 4)
 *
 * "Started" means 30.2 km on a 30 km package is 1 extra km, and 5 h 01 min on
 * a 5 h package is one extra block: the customer is told so up front. The
 * result is rounded to whole rupees, like normal fares. Pure — the server is
 * the only caller whose result is ever trusted.
 */

export interface CircuitTariff {
  basePrice: number;
  includedDistanceMeters: number;
  includedDurationSeconds: number;
  extraDistanceRatePerKm: number;
  extraDurationRatePerHour: number;
}

export interface CircuitFareBreakdown {
  basePrice: number;
  /** Whole kilometres billed above the included distance. */
  extraKm: number;
  extraDistanceCharge: number;
  /** 15-minute blocks billed above the included duration. */
  extraBlocks: number;
  extraDurationCharge: number;
  subtotal: number;
  /** Whole rupees. */
  total: number;
}

export const EXTRA_TIME_BLOCK_SECONDS = 15 * 60;

const toPaise = (rupees: number): number => Math.round(rupees * 100);

export function calculateCircuitFare(
  tariff: CircuitTariff,
  usedDistanceMeters: number,
  usedDurationSeconds: number,
): CircuitFareBreakdown {
  if (usedDistanceMeters < 0 || usedDurationSeconds < 0) throw new RangeError("Distance and duration must be non-negative");

  const extraMeters = Math.max(0, usedDistanceMeters - tariff.includedDistanceMeters);
  const extraKm = Math.ceil(extraMeters / 1000);
  const extraSeconds = Math.max(0, usedDurationSeconds - tariff.includedDurationSeconds);
  const extraBlocks = Math.ceil(extraSeconds / EXTRA_TIME_BLOCK_SECONDS);

  const distancePaise = extraKm * toPaise(tariff.extraDistanceRatePerKm);
  const durationPaise = Math.round((extraBlocks * toPaise(tariff.extraDurationRatePerHour)) / 4);
  const subtotalPaise = toPaise(tariff.basePrice) + distancePaise + durationPaise;

  return {
    basePrice: tariff.basePrice,
    extraKm,
    extraDistanceCharge: distancePaise / 100,
    extraBlocks,
    extraDurationCharge: durationPaise / 100,
    subtotal: subtotalPaise / 100,
    total: Math.round(subtotalPaise / 100),
  };
}

/** How much of the package is used up, 0..1+, for warnings and progress bars. */
export const usageRatio = (used: number, included: number): number => (included > 0 ? used / included : 0);

export type UsageWarning = "TIME_30_MIN" | "TIME_10_MIN" | "TIME_EXHAUSTED" | "DISTANCE_80" | "DISTANCE_EXHAUSTED";

/** Remaining time (seconds) at which each time warning fires. */
export const TIME_WARNING_THRESHOLDS = { TIME_30_MIN: 30 * 60, TIME_10_MIN: 10 * 60 } as const;
/** Share of the included distance used when the "running low" warning fires. */
export const DISTANCE_LOW_RATIO = 0.8;

/** Every warning that is due for this usage, most urgent first. The caller de-duplicates against what it already sent. */
export function dueWarnings(
  tariff: Pick<CircuitTariff, "includedDistanceMeters" | "includedDurationSeconds">,
  usedDistanceMeters: number,
  usedDurationSeconds: number,
): UsageWarning[] {
  const due: UsageWarning[] = [];
  const remaining = tariff.includedDurationSeconds - usedDurationSeconds;
  if (remaining <= 0) due.push("TIME_EXHAUSTED");
  else if (remaining <= TIME_WARNING_THRESHOLDS.TIME_10_MIN) due.push("TIME_10_MIN");
  else if (remaining <= TIME_WARNING_THRESHOLDS.TIME_30_MIN) due.push("TIME_30_MIN");
  if (usedDistanceMeters >= tariff.includedDistanceMeters) due.push("DISTANCE_EXHAUSTED");
  else if (usedDistanceMeters >= tariff.includedDistanceMeters * DISTANCE_LOW_RATIO) due.push("DISTANCE_80");
  return due;
}
