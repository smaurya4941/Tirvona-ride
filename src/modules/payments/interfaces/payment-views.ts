import type { RidePaymentStatus } from "../../rides/ride-payment-status";
import type { RideFinalFareView } from "../../rides/ride-view.service";
import type { AdjustmentView } from "../../earnings/interfaces/earning-views";
import type { PaymentAttemptStatus, PaymentEventSource, PaymentStatus } from "./payment-status";
import type {
  PaymentRefundState,
  RefundDriverImpact,
  RefundLedgerState,
  RefundReason,
  RefundSource,
  RefundStatus,
  RefundTarget,
} from "./refund-status";

// API shapes. Amounts are rupees (stored as paise).

export interface PaymentMethodView {
  method?: string;
  bank?: string;
  wallet?: string;
  cardNetwork?: string;
  cardType?: string;
  cardLast4?: string;
}

export interface PaymentView {
  id: string;
  rideId: string;
  rideCode: string;
  gateway: string;
  amount: number;
  currency: string;
  status: PaymentStatus;
  /** The ride's money state — what the apps branch on. */
  ridePaymentStatus: RidePaymentStatus;
  method?: string;
  methodDetails?: PaymentMethodView;
  razorpayOrderId?: string;
  razorpayPaymentId?: string;
  failureReason?: string;
  paidAt?: Date;
  /** Customer money refunded (processed) and on its way; absent when never refunded. */
  refund?: {
    refundId?: string;
    amount: number;
    pending: number;
    status?: PaymentRefundState;
    refundedAt?: Date;
  };
  createdAt: Date;
  updatedAt: Date;
}

/** Everything the app needs to open Razorpay Standard Checkout. */
export interface CheckoutView {
  payment: PaymentView;
  checkout: {
    key: string;
    orderId: string;
    /** Paise — exactly what the order was created for. */
    amount: number;
    currency: string;
    name: string;
    description: string;
    prefill: { name?: string; contact?: string; email?: string };
    notes: Record<string, string>;
  };
}

export interface ReceiptPlace {
  address: string;
  latitude: number;
  longitude: number;
}

/** In-app receipt (V1 has no PDF). */
export interface PaymentReceiptView extends PaymentView {
  ride: {
    id: string;
    rideCode: string;
    rideType: string;
    pickup: ReceiptPlace;
    destination: ReceiptPlace;
    distanceMeters: number;
    durationSeconds: number;
    requestedAt: Date;
    startedAt?: Date;
    completedAt?: Date;
    fare: {
      currency: string;
      baseFare: number;
      distanceCharge: number;
      timeCharge: number;
      subtotal: number;
      minimumFare: number;
      minimumFareApplied: boolean;
      estimatedFare: number;
      finalFare?: number;
      discount?: number;
      payableFare?: number;
      /** The frozen final bill (actual trip measured, components). */
      final?: RideFinalFareView;
    };
  };
  customer: { name: string; phone?: string };
  driver: { name: string } | null;
  refunds: CustomerRefundView[];
  vehicle: { vehicleType: string; registrationNumber: string; make?: string; model?: string; color?: string } | null;
}

export interface PaymentHistoryItem extends PaymentView {
  rideType?: string;
  pickupAddress?: string;
  destinationAddress?: string;
  rideCompletedAt?: Date;
}

// ── Admin ───────────────────────────────────────────────────────────────

export interface AdminPaymentPerson {
  id: string;
  name: string;
  phone: string;
}

export interface AdminPaymentListItem extends PaymentView {
  customer: AdminPaymentPerson | null;
  driver: (AdminPaymentPerson & { driverId: string; driverCode: string }) | null;
  attempts: number;
  needsAttention: boolean;
}

export interface AdminPaymentDetail extends AdminPaymentListItem {
  ride: {
    id: string;
    rideCode: string;
    status: string;
    rideType: string;
    pickupAddress: string;
    destinationAddress: string;
    completedAt?: Date;
    finalFare?: number;
    estimatedFare: number;
    discount?: number;
    payableFare?: number;
    final?: RideFinalFareView;
  } | null;
  /** Still refundable (rupees): captured − processed − in-flight refunds. */
  refundable: number;
  refunds: RefundView[];
  /** Driver clawbacks caused by this payment's refunds. */
  adjustments: AdjustmentView[];
  attemptLog: Array<{
    orderId: string;
    amount: number;
    status: PaymentAttemptStatus;
    razorpayPaymentId?: string;
    failureCode?: string;
    failureReason?: string;
    createdAt?: Date;
    updatedAt?: Date;
  }>;
  events: Array<{
    type: string;
    source: PaymentEventSource;
    at: Date;
    razorpayOrderId?: string;
    razorpayPaymentId?: string;
    detail?: string;
    fromStatus?: string;
    toStatus?: string;
    actorId?: string;
    amount?: number;
    refundId?: string;
  }>;
  duplicateCaptures: Array<{
    razorpayPaymentId: string;
    razorpayOrderId?: string;
    amount: number;
    detectedAt: Date;
    refunded: number;
    refundState: PaymentRefundState;
  }>;
  earning: {
    id: string;
    grossFare: number;
    /** The ride type the commission was resolved for. */
    rideType: string;
    commissionRate: number;
    commissionVersion: number;
    commissionAmount: number;
    netEarning: number;
    status: string;
  } | null;
}

export interface AdminPaymentsSummary {
  currency: string;
  collectedToday: number;
  capturedToday: number;
  collectedTotal: number;
  capturedTotal: number;
  /** Paid to drivers in cash (not collected by Tirvona). */
  cashToday: number;
  cashRidesToday: number;
  cashTotal: number;
  cashRidesTotal: number;
  /** Commission on cash rides that drivers owe Tirvona. */
  commissionDue: number;
  commissionTotal: number;
  failedToday: number;
  /** Completed rides still waiting for the customer to pay. */
  outstandingRides: number;
  outstandingAmount: number;
  /** Payments with a duplicate capture not yet refunded. */
  needsAttention: number;
  refundedToday: number;
  refundedTotal: number;
  /** Refunds requested or pending at Razorpay. */
  refundsPending: number;
  /** Refunds failed in the last 30 days. */
  refundsFailed: number;
  /** Dashboard refunds awaiting a decision on the driver's share. */
  refundsToReview: number;
  /** Refund clawbacks still to be deducted from driver payouts. */
  deductionsOutstanding: number;
}

// ── Refunds ─────────────────────────────────────────────────────────────

export interface RefundView {
  id: string;
  paymentId: string;
  rideId: string;
  rideCode: string;
  target: RefundTarget;
  razorpayPaymentId: string;
  razorpayRefundId?: string;
  amount: number;
  currency: string;
  reason: RefundReason;
  note?: string;
  driverImpact: RefundDriverImpact;
  status: RefundStatus;
  failureReason?: string;
  /** ARN / RRN once processed — what the customer's bank can trace. */
  acquirerReference?: string;
  speedProcessed?: string;
  source: RefundSource;
  requestedBy?: { id: string; name: string };
  ledgerState: RefundLedgerState;
  adjustment?: { id: string; amount?: number; status?: string };
  needsReview: boolean;
  createdAt: Date;
  processedAt?: Date;
  failedAt?: Date;
}

export interface AdminRefundListItem extends RefundView {
  customer: { name: string; phone?: string } | null;
}

/** Receipt view: no admin notes, no failed attempts. */
export interface CustomerRefundView {
  id: string;
  amount: number;
  currency: string;
  status: RefundStatus;
  /** Customer wording ("Fare adjustment"). */
  reason: string;
  reference?: string;
  createdAt: Date;
  processedAt?: Date;
}

// ── Reconciliation ──────────────────────────────────────────────────────

export type ExceptionSeverity = "CRITICAL" | "WARNING" | "INFO";

export interface PaymentExceptionItem {
  kind:
    | "DUPLICATE_UNREFUNDED"
    | "WEBHOOK_FLAGGED"
    | "WEBHOOK_FAILED"
    | "REFUND_FAILED"
    | "REFUND_STUCK"
    | "REFUND_REVIEW"
    | "EARNING_MISSING"
    | "PROCESSING_STALE"
    | "LEDGER_PENDING"
    | "RUN_EXCEPTION";
  severity: ExceptionSeverity;
  paymentId?: string;
  rideCode?: string;
  /** pay_… / rfnd_… / event id — what to search for at Razorpay. */
  reference?: string;
  amount?: number;
  detail: string;
  at: Date;
  runId?: string;
  exceptionId?: string;
}

export interface ReconciliationRunView {
  id: string;
  key: string;
  trigger: string;
  from: Date;
  to: Date;
  status: string;
  startedAt: Date;
  finishedAt?: Date;
  stats: {
    gatewayPayments: number;
    ridePayments: number;
    foreignPayments: number;
    matched: number;
    recordedChecked: number;
    exceptions: number;
    healed: number;
    gatewayCaptured: number;
    recordedCaptured: number;
  };
  /** Exceptions neither healed nor resolved by an admin. */
  unresolved: number;
  truncated: boolean;
  error?: string;
  exceptions?: Array<{
    id: string;
    type: string;
    severity: string;
    paymentId?: string;
    rideCode?: string;
    razorpayPaymentId?: string;
    razorpayOrderId?: string;
    expected?: string;
    actual?: string;
    detail: string;
    healed: boolean;
    resolvedAt?: Date;
    resolutionNote?: string;
  }>;
}

export interface PaymentExceptionsView {
  counts: Record<ExceptionSeverity, number>;
  items: PaymentExceptionItem[];
  lastRun: ReconciliationRunView | null;
}
