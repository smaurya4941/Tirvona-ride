/**
 * Money crosses the API in rupees (₹195.50) but every stored ledger amount
 * and every gateway amount is an integer number of paise, so sums and
 * percentages can never drift by floating-point error.
 */
export const toPaise = (rupees: number): number => Math.round(rupees * 100);

export const toRupees = (paise: number): number => paise / 100;

/** Rate in percent with up to two decimals (17.5 → 1750 basis points). */
export const percentToBasisPoints = (percent: number): number => Math.round(percent * 100);

/**
 * `percent` of `amountPaise`, rounded half-up to the nearest paisa.
 * ₹350 at 15% → 5250 paise (₹52.50).
 */
export function percentOfPaise(amountPaise: number, percent: number): number {
  if (!Number.isInteger(amountPaise) || amountPaise < 0)
    throw new RangeError("amountPaise must be a non-negative integer");
  const basisPoints = percentToBasisPoints(percent);
  if (basisPoints < 0 || basisPoints > 10_000) throw new RangeError("percent must be between 0 and 100");
  return Math.floor((amountPaise * basisPoints + 5_000) / 10_000);
}
