import { percentOfPaise } from "../../common/utils/money";

export interface CommissionSplit {
  grossFarePaise: number;
  /** Percent applied, e.g. 20. */
  commissionRate: number;
  commissionPaise: number;
  netEarningPaise: number;
}

/**
 * driver earning = final fare − Tirvona commission, in integer paise.
 * ₹350 at 15% → commission ₹52.50, driver ₹297.50. The commission is
 * rounded half-up to the paisa and the driver gets exactly the remainder,
 * so the two always add back up to the fare.
 */
export function splitFare(grossFarePaise: number, commissionPercent: number): CommissionSplit {
  const commissionPaise = percentOfPaise(grossFarePaise, commissionPercent);
  return {
    grossFarePaise,
    commissionRate: commissionPercent,
    commissionPaise,
    netEarningPaise: grossFarePaise - commissionPaise,
  };
}
