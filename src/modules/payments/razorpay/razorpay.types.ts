// The subset of Razorpay's REST entities Tirvona reads. Amounts are paise;
// timestamps are Unix seconds. https://razorpay.com/docs/api/

export interface RazorpayOrder {
  id: string;
  entity: "order";
  amount: number;
  amount_paid: number;
  amount_due: number;
  currency: string;
  receipt?: string | null;
  status: "created" | "attempted" | "paid";
  attempts: number;
  notes?: Record<string, string> | unknown[];
  created_at: number;
}

export type RazorpayPaymentStatus = "created" | "authorized" | "captured" | "refunded" | "failed";

export interface RazorpayPayment {
  id: string;
  entity: "payment";
  amount: number;
  currency: string;
  status: RazorpayPaymentStatus;
  order_id: string | null;
  method?: string;
  captured?: boolean;
  amount_refunded?: number;
  refund_status?: "null" | "partial" | "full" | null;
  bank?: string | null;
  wallet?: string | null;
  card?: { network?: string | null; type?: string | null; last4?: string | null } | null;
  error_code?: string | null;
  error_description?: string | null;
  error_reason?: string | null;
  notes?: Record<string, string> | unknown[];
  created_at: number;
}

export interface RazorpayRefund {
  id: string;
  entity: "refund";
  payment_id: string;
  amount: number;
  currency: string;
  status: "pending" | "processed" | "failed";
  created_at: number;
}

/** Webhook body (only the parts Tirvona uses). */
export interface RazorpayWebhookBody {
  entity: "event";
  account_id?: string;
  event: string;
  contains?: string[];
  created_at?: number;
  payload: {
    payment?: { entity: RazorpayPayment };
    order?: { entity: RazorpayOrder };
    refund?: { entity: RazorpayRefund };
  };
}

export interface CreateOrderInput {
  amountPaise: number;
  currency: string;
  /** Our reference (ride code); ≤ 40 chars. */
  receipt: string;
  notes: Record<string, string>;
}
