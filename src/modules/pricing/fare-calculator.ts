export interface PricingRates {
  currency: string;
  baseFare: number;
  perKmRate: number;
  perMinuteRate: number;
  minimumFare: number;
}

export interface FareBreakdown extends PricingRates {
  distanceKm: number;
  durationMinutes: number;
  distanceCharge: number;
  timeCharge: number;
  /** base + distance + time, before the minimum-fare floor and rounding. */
  subtotal: number;
  minimumFareApplied: boolean;
  /** What the customer pays: max(subtotal, minimumFare), rounded to ₹1. */
  total: number;
}

// All arithmetic happens in paise (integers) so repeated float additions can
// never produce ₹120.00000000001; rupees only appear at the edges.
const toPaise = (rupees: number): number => Math.round(rupees * 100);
const toRupees = (paise: number): number => paise / 100;
const round2 = (value: number): number => Math.round(value * 100) / 100;

/**
 * base + perKm × km + perMinute × minutes, floored at the minimum fare and
 * rounded to the nearest whole rupee. Pure — the server is the only caller
 * whose result is ever trusted.
 */
export function calculateFare(
  rates: PricingRates,
  distanceMeters: number,
  durationSeconds: number,
): FareBreakdown {
  if (distanceMeters < 0 || durationSeconds < 0)
    throw new RangeError("Distance and duration must be non-negative");

  const distanceChargePaise = Math.round((toPaise(rates.perKmRate) * distanceMeters) / 1000);
  const timeChargePaise = Math.round((toPaise(rates.perMinuteRate) * durationSeconds) / 60);
  const subtotalPaise = toPaise(rates.baseFare) + distanceChargePaise + timeChargePaise;
  const minimumPaise = toPaise(rates.minimumFare);
  const minimumFareApplied = subtotalPaise < minimumPaise;
  const payablePaise = Math.max(subtotalPaise, minimumPaise);
  const totalPaise = Math.round(payablePaise / 100) * 100;

  return {
    currency: rates.currency,
    baseFare: rates.baseFare,
    perKmRate: rates.perKmRate,
    perMinuteRate: rates.perMinuteRate,
    minimumFare: rates.minimumFare,
    distanceKm: round2(distanceMeters / 1000),
    durationMinutes: round2(durationSeconds / 60),
    distanceCharge: toRupees(distanceChargePaise),
    timeCharge: toRupees(timeChargePaise),
    subtotal: toRupees(subtotalPaise),
    minimumFareApplied,
    total: toRupees(totalPaise),
  };
}
