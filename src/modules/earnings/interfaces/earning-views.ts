import type {
  AdjustmentStatus,
  AdjustmentType,
  CommissionConfigStatus,
  CommissionPhase,
  CommissionType,
  EarningStatus,
  EarningsPeriod,
  PaymentMode,
} from "./earning-status";

// API shapes. Stored amounts are paise; every amount below is rupees.

export interface CommissionView {
  id: string;
  version: number;
  type: CommissionType;
  /** Percent of the gross fare. */
  value: number;
  effectiveFrom: Date;
  status: CommissionConfigStatus;
  phase: CommissionPhase;
  note?: string;
  createdBy?: string;
  createdAt: Date;
  cancelledAt?: Date;
}

export interface EarningView {
  id: string;
  rideId: string;
  rideCode: string;
  rideType: string;
  paymentId: string;
  pickupAddress?: string;
  destinationAddress?: string;
  rideCompletedAt: Date;
  currency: string;
  grossFare: number;
  /** Platform-funded promo discount the customer received (rupees). */
  promoDiscount: number;
  commissionType: CommissionType;
  /** Percent captured when the earning was recorded. */
  commissionRate: number;
  commissionAmount: number;
  netEarning: number;
  /** CASH: the driver collected the fare; ONLINE: paid via Razorpay. */
  paymentMode: PaymentMode;
  /** "cash", or Razorpay's method (upi, card, netbanking, wallet…). */
  paymentMethod?: string;
  status: EarningStatus;
  availableAt: Date;
  payoutId?: string;
  paidAt?: Date;
  payoutReference?: string;
  payoutNote?: string;
  createdAt: Date;
  /** Refund deductions on this ride (detail view only). */
  adjustments?: AdjustmentView[];
}

export interface EarningsWindow {
  /** Driver's share (what the driver cares about). */
  net: number;
  gross: number;
  commission: number;
  rides: number;
}

export interface EarningsBalances {
  pending: number;
  available: number;
  paid: number;
  /** Driver's share of cash fares — already in their hand, never paid out. */
  collected: number;
  /** Tirvona's commission on cash fares, owed by the driver. */
  commissionDue: number;
  /** Refund clawbacks still to be deducted from the driver's next payout. */
  deductions: number;
}

/** A correction to the driver's earnings after the ride (refund clawback). */
export interface AdjustmentView {
  id: string;
  type: AdjustmentType;
  earningId: string;
  rideId: string;
  rideCode: string;
  paymentId: string;
  refundId: string;
  reason: string;
  currency: string;
  /** What the customer got back. */
  refundAmount: number;
  grossReversal: number;
  commissionReversal: number;
  /** Deducted from the driver. */
  amount: number;
  commissionRate: number;
  status: AdjustmentStatus;
  payoutId?: string;
  settledAt?: Date;
  waiverNote?: string;
  createdAt: Date;
}

export interface EarningsSummary {
  currency: string;
  today: EarningsWindow;
  week: EarningsWindow;
  month: EarningsWindow;
  total: EarningsWindow;
  balances: EarningsBalances;
}

export interface Paged<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
}

export interface DriverEarningsResponse extends Paged<EarningView> {
  period: EarningsPeriod;
  /** Recent refund clawbacks (first page only). */
  adjustments: AdjustmentView[];
  /** Totals of the selected period (the list below). */
  periodTotals: EarningsWindow;
  summary: EarningsSummary;
}

export interface DriverRef {
  driverId: string;
  userId: string;
  driverCode: string;
  name: string;
  phone: string;
}

export interface AdminDriverEarningsRow extends EarningsBalances {
  driver: DriverRef;
  rides: number;
  gross: number;
  commission: number;
  net: number;
  lastEarningAt?: Date;
}

export interface AdminEarningsTotals extends EarningsBalances {
  currency: string;
  rides: number;
  gross: number;
  commission: number;
  net: number;
  drivers: number;
}

export interface PayoutView {
  id: string;
  driverId: string;
  earningIds: string[];
  earningCount: number;
  /** Earnings settled, before deductions. */
  grossAmount: number;
  /** Refund clawbacks recovered in this payout. */
  deductionAmount: number;
  adjustmentIds: string[];
  /** Transferred to the driver: gross − deductions. */
  amount: number;
  currency: string;
  payoutReference: string;
  note?: string;
  paidBy: { id: string; name: string };
  paidAt: Date;
}

export interface AdminDriverEarningsDetail {
  driver: DriverRef;
  summary: AdminDriverEarningsRow;
  ledger: Paged<EarningView>;
  payouts: PayoutView[];
  adjustments: AdjustmentView[];
}
