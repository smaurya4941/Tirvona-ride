/** What a ride's earning line recorded (paise). */
export interface EarningAmounts {
  grossFarePaise: number;
  commissionPaise: number;
  netEarningPaise: number;
}

export interface ClawbackInput {
  earning: EarningAmounts;
  /** What the customer actually paid for the ride (fare − promo). */
  paidAmountPaise: number;
  /** This refund. */
  refundAmountPaise: number;
  /** Refunds already clawed back on this earning (processed before this one). */
  previousRefundsPaise: number;
  /** Reversals already recorded on this earning. */
  previous: { grossPaise: number; commissionPaise: number };
}

export interface Clawback {
  grossReversalPaise: number;
  commissionReversalPaise: number;
  /** Deducted from the driver. */
  amountPaise: number;
}

/**
 * The driver's share of a refund, at the earning line's own snapshot: the
 * refunded fraction of what the customer paid is applied to the line's gross
 * and commission (so the commission rate in force at the ride is honoured,
 * not today's). Rounded half-up per refund; the refund that brings the total
 * to the full amount paid reverses exactly what remains, so partial refunds
 * summing to a full one leave no rounding residue. Never reverses more than
 * the line recorded.
 */
export function refundClawback(input: ClawbackInput): Clawback {
  const { earning } = input;
  if (input.paidAmountPaise <= 0 || input.refundAmountPaise <= 0)
    return {
      grossReversalPaise: 0,
      commissionReversalPaise: 0,
      amountPaise: 0,
    };

  const remainingGross = Math.max(
    0,
    earning.grossFarePaise - input.previous.grossPaise,
  );
  const remainingCommission = Math.max(
    0,
    earning.commissionPaise - input.previous.commissionPaise,
  );
  const fullyRefunded =
    input.previousRefundsPaise + input.refundAmountPaise >=
    input.paidAmountPaise;

  let gross: number;
  let commission: number;
  if (fullyRefunded) {
    gross = remainingGross;
    commission = remainingCommission;
  } else {
    const fraction = input.refundAmountPaise / input.paidAmountPaise;
    gross = Math.min(
      remainingGross,
      Math.round(earning.grossFarePaise * fraction),
    );
    commission = Math.min(
      remainingCommission,
      Math.round(earning.commissionPaise * fraction),
    );
  }
  const amount = Math.max(0, gross - commission);
  return {
    grossReversalPaise: gross,
    commissionReversalPaise: commission,
    amountPaise: amount,
  };
}
