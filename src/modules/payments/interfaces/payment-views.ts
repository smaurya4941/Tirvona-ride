import type { RidePaymentStatus } from "../../rides/ride-payment-status";
import type { PaymentAttemptStatus, PaymentEventSource, PaymentStatus } from "./payment-status";

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
  refund?: { refundId?: string; amount: number; status?: string; refundedAt?: Date };
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
    };
  };
  customer: { name: string; phone?: string };
  driver: { name: string } | null;
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
  } | null;
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
  }>;
  duplicateCaptures: Array<{ razorpayPaymentId: string; razorpayOrderId?: string; amount: number; detectedAt: Date }>;
  earning: {
    id: string;
    grossFare: number;
    commissionRate: number;
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
  /** Duplicate captures awaiting a manual refund. */
  needsAttention: number;
}
