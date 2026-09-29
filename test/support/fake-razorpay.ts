import { RazorpayGateway, RazorpayGatewayError } from "../../src/modules/payments/razorpay/razorpay.gateway";
import type {
  CreateOrderInput,
  CreateRefundInput,
  ListPaymentsInput,
  RazorpayOrder,
  RazorpayPayment,
  RazorpayPaymentStatus,
  RazorpayRefund,
} from "../../src/modules/payments/razorpay/razorpay.types";

/**
 * Razorpay with the same contract, in memory: orders, payments (capture,
 * failure), refunds (pending/processed, partial, over-refund rejection) and
 * the payment listing used by reconciliation runs. Behaviour switches let a
 * test simulate an outage, a rejected refund, or a refund whose create
 * response is lost after Razorpay registered it.
 */
export class FakeRazorpay extends RazorpayGateway {
  readonly isConfigured = true;
  readonly keyId = "rzp_test_E2EKEY123";
  readonly orders = new Map<string, RazorpayOrder>();
  readonly payments = new Map<string, RazorpayPayment>();
  readonly refunds = new Map<string, RazorpayRefund>();
  unreachable = false;
  /** processed: refunds complete at once; pending: until processRefund(). */
  refundSpeed: "processed" | "pending" = "processed";
  /** reject: 400 on create; lost: refund created, then a timeout is thrown. */
  refundFailure: "none" | "reject" | "lost" = "none";
  ordersCreated = 0;
  refundsCreated = 0;
  private seq = 0;

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}_E2E${this.seq.toString().padStart(8, "0")}`;
  }

  private guard(): void {
    if (this.unreachable) throw new RazorpayGatewayError("Could not reach Razorpay: timeout");
  }

  async createOrder(input: CreateOrderInput): Promise<RazorpayOrder> {
    this.guard();
    const order: RazorpayOrder = {
      id: this.nextId("order"),
      entity: "order",
      amount: input.amountPaise,
      amount_paid: 0,
      amount_due: input.amountPaise,
      currency: input.currency,
      receipt: input.receipt,
      status: "created",
      attempts: 0,
      notes: input.notes,
      created_at: Math.floor(Date.now() / 1000),
    };
    this.orders.set(order.id, order);
    this.ordersCreated += 1;
    return order;
  }

  async fetchPayment(paymentId: string): Promise<RazorpayPayment> {
    this.guard();
    const payment = this.payments.get(paymentId);
    if (!payment) throw new RazorpayGatewayError("The id provided does not exist", 400, "BAD_REQUEST_ERROR");
    return { ...payment };
  }

  async capturePayment(paymentId: string, amountPaise: number): Promise<RazorpayPayment> {
    this.guard();
    const payment = this.payments.get(paymentId);
    if (!payment || payment.status !== "authorized" || payment.amount !== amountPaise)
      throw new RazorpayGatewayError("Capture not allowed", 400, "BAD_REQUEST_ERROR");
    payment.status = "captured";
    payment.captured = true;
    return { ...payment };
  }

  async fetchOrderPayments(orderId: string): Promise<RazorpayPayment[]> {
    this.guard();
    return [...this.payments.values()].filter((payment) => payment.order_id === orderId).map((p) => ({ ...p }));
  }

  async createRefund(input: CreateRefundInput): Promise<RazorpayRefund> {
    this.guard();
    if (this.refundFailure === "reject")
      throw new RazorpayGatewayError("The refund could not be initiated for this payment", 400, "BAD_REQUEST_ERROR");
    const payment = this.payments.get(input.razorpayPaymentId);
    if (!payment || (payment.status !== "captured" && payment.status !== "refunded"))
      throw new RazorpayGatewayError("The payment has not been captured", 400, "BAD_REQUEST_ERROR");
    const refunded = payment.amount_refunded ?? 0;
    if (refunded + input.amountPaise > payment.amount)
      throw new RazorpayGatewayError("The total refund amount is greater than the refund payment amount", 400, "BAD_REQUEST_ERROR");

    const refund: RazorpayRefund = {
      id: this.nextId("rfnd"),
      entity: "refund",
      payment_id: payment.id,
      amount: input.amountPaise,
      currency: payment.currency,
      status: this.refundSpeed,
      notes: input.notes,
      receipt: input.receipt,
      speed_processed: "normal",
      acquirer_data: this.refundSpeed === "processed" ? { arn: `ARN${this.seq}` } : null,
      created_at: Math.floor(Date.now() / 1000),
    };
    this.refunds.set(refund.id, refund);
    this.refundsCreated += 1;
    payment.amount_refunded = refunded + input.amountPaise;
    payment.refund_status = payment.amount_refunded >= payment.amount ? "full" : "partial";
    if (payment.amount_refunded >= payment.amount) payment.status = "refunded";
    if (this.refundFailure === "lost") throw new RazorpayGatewayError("Could not reach Razorpay: timeout");
    return { ...refund };
  }

  async fetchRefund(razorpayPaymentId: string, refundId: string): Promise<RazorpayRefund> {
    this.guard();
    const refund = this.refunds.get(refundId);
    if (!refund || refund.payment_id !== razorpayPaymentId)
      throw new RazorpayGatewayError("The id provided does not exist", 400, "BAD_REQUEST_ERROR");
    return { ...refund };
  }

  async fetchPaymentRefunds(razorpayPaymentId: string): Promise<RazorpayRefund[]> {
    this.guard();
    return [...this.refunds.values()].filter((refund) => refund.payment_id === razorpayPaymentId).map((r) => ({ ...r }));
  }

  async listPayments(input: ListPaymentsInput): Promise<RazorpayPayment[]> {
    this.guard();
    return [...this.payments.values()]
      .filter((payment) => payment.created_at >= input.from && payment.created_at <= input.to)
      .sort((a, b) => b.created_at - a.created_at)
      .slice(input.skip, input.skip + input.count)
      .map((payment) => ({ ...payment }));
  }

  // ── Test controls ─────────────────────────────────────────────────────

  /** The customer completing (or failing) the checkout sheet. */
  pay(
    orderId: string,
    options: { status?: RazorpayPaymentStatus; method?: string; amount?: number; notes?: Record<string, string> } = {},
  ): RazorpayPayment {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`Unknown order ${orderId}`);
    const status = options.status ?? "captured";
    const payment: RazorpayPayment = {
      id: this.nextId("pay"),
      entity: "payment",
      amount: options.amount ?? order.amount,
      currency: order.currency,
      status,
      order_id: orderId,
      method: options.method ?? "upi",
      captured: status === "captured",
      amount_refunded: 0,
      bank: null,
      wallet: null,
      card: null,
      error_code: status === "failed" ? "BAD_REQUEST_ERROR" : null,
      error_description: status === "failed" ? "Payment failed due to incorrect UPI PIN" : null,
      notes: options.notes ?? (order.notes as Record<string, string>),
      created_at: Math.floor(Date.now() / 1000),
    };
    this.payments.set(payment.id, payment);
    order.status = status === "captured" ? "paid" : "attempted";
    order.attempts += 1;
    return payment;
  }

  /** A payment of another app on the same Razorpay account. */
  foreignPayment(amountPaise: number): RazorpayPayment {
    const payment: RazorpayPayment = {
      id: this.nextId("pay"),
      entity: "payment",
      amount: amountPaise,
      currency: "INR",
      status: "captured",
      order_id: this.nextId("order"),
      method: "card",
      captured: true,
      notes: { app: "tirvona-main" },
      created_at: Math.floor(Date.now() / 1000),
    };
    this.payments.set(payment.id, payment);
    return payment;
  }

  /** A refund made in the Razorpay dashboard (not through Tirvona). */
  dashboardRefund(razorpayPaymentId: string, amountPaise: number): RazorpayRefund {
    const payment = this.payments.get(razorpayPaymentId);
    if (!payment) throw new Error(`Unknown payment ${razorpayPaymentId}`);
    const refund: RazorpayRefund = {
      id: this.nextId("rfnd"),
      entity: "refund",
      payment_id: razorpayPaymentId,
      amount: amountPaise,
      currency: payment.currency,
      status: "processed",
      notes: {},
      speed_processed: "normal",
      created_at: Math.floor(Date.now() / 1000),
    };
    this.refunds.set(refund.id, refund);
    payment.amount_refunded = (payment.amount_refunded ?? 0) + amountPaise;
    if (payment.amount_refunded >= payment.amount) payment.status = "refunded";
    return refund;
  }

  processRefund(refundId: string): RazorpayRefund {
    const refund = this.refunds.get(refundId);
    if (!refund) throw new Error(`Unknown refund ${refundId}`);
    refund.status = "processed";
    refund.acquirer_data = { arn: `ARN-${refundId}` };
    return { ...refund };
  }

  failRefund(refundId: string): RazorpayRefund {
    const refund = this.refunds.get(refundId);
    if (!refund) throw new Error(`Unknown refund ${refundId}`);
    refund.status = "failed";
    const payment = this.payments.get(refund.payment_id);
    if (payment) {
      payment.amount_refunded = Math.max(0, (payment.amount_refunded ?? 0) - refund.amount);
      if (payment.status === "refunded" && payment.amount_refunded < payment.amount) payment.status = "captured";
    }
    return { ...refund };
  }
}
