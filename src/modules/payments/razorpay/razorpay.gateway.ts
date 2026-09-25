import type { CreateOrderInput, RazorpayOrder, RazorpayPayment } from "./razorpay.types";

/** A Razorpay API call that did not succeed. */
export class RazorpayGatewayError extends Error {
  constructor(
    message: string,
    /** HTTP status from Razorpay; undefined for network errors/timeouts. */
    readonly status?: number,
    /** Razorpay's `error.code`, e.g. BAD_REQUEST_ERROR. */
    readonly code?: string,
  ) {
    super(message);
    this.name = "RazorpayGatewayError";
  }

  /** Network trouble or a Razorpay-side 5xx — worth retrying later. */
  get transient(): boolean {
    return this.status === undefined || this.status >= 500 || this.status === 429;
  }
}

/**
 * The only door to Razorpay. PaymentsService depends on this abstraction,
 * so the e2e suite swaps in a deterministic fake while production uses
 * RazorpayHttpGateway against the real (test-mode or live) API.
 */
export abstract class RazorpayGateway {
  /** Key id and secret are present. */
  abstract readonly isConfigured: boolean;

  /** Public key id handed to the checkout (never the secret). */
  abstract readonly keyId: string;

  abstract createOrder(input: CreateOrderInput): Promise<RazorpayOrder>;

  abstract fetchPayment(paymentId: string): Promise<RazorpayPayment>;

  /** Captures an authorised payment for exactly `amountPaise`. */
  abstract capturePayment(paymentId: string, amountPaise: number, currency: string): Promise<RazorpayPayment>;

  /** Every payment attempted against an order (newest first as Razorpay returns them). */
  abstract fetchOrderPayments(orderId: string): Promise<RazorpayPayment[]>;
}
