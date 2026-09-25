import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { RazorpayGateway, RazorpayGatewayError } from "./razorpay.gateway";
import type { CreateOrderInput, RazorpayOrder, RazorpayPayment } from "./razorpay.types";

interface RazorpayErrorBody {
  error?: { code?: string; description?: string };
}

/**
 * Razorpay REST v1 over HTTPS with HTTP Basic auth (key id : key secret).
 * Uses Node's fetch — no SDK — with a hard timeout on every call so a slow
 * gateway can never pin a request thread.
 */
@Injectable()
export class RazorpayHttpGateway extends RazorpayGateway {
  private readonly logger = new Logger(RazorpayHttpGateway.name);
  readonly keyId: string;
  private readonly keySecret: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    super();
    this.keyId = config.get<string>("razorpayKeyId") ?? "";
    this.keySecret = config.get<string>("razorpayKeySecret") ?? "";
    this.baseUrl = config.getOrThrow<string>("razorpayApiBaseUrl");
    this.timeoutMs = config.getOrThrow<number>("razorpayTimeoutMs");
    if (!this.isConfigured) this.logger.warn("Razorpay keys are not set: customer payments are disabled");
    else if (this.keyId.startsWith("rzp_test_")) this.logger.log("Razorpay is in TEST mode");
  }

  get isConfigured(): boolean {
    return Boolean(this.keyId && this.keySecret);
  }

  createOrder(input: CreateOrderInput): Promise<RazorpayOrder> {
    return this.request<RazorpayOrder>("POST", "/orders", {
      amount: input.amountPaise,
      currency: input.currency,
      receipt: input.receipt.slice(0, 40),
      notes: input.notes,
    });
  }

  fetchPayment(paymentId: string): Promise<RazorpayPayment> {
    return this.request<RazorpayPayment>("GET", `/payments/${encodeURIComponent(paymentId)}`);
  }

  capturePayment(paymentId: string, amountPaise: number, currency: string): Promise<RazorpayPayment> {
    return this.request<RazorpayPayment>("POST", `/payments/${encodeURIComponent(paymentId)}/capture`, {
      amount: amountPaise,
      currency,
    });
  }

  async fetchOrderPayments(orderId: string): Promise<RazorpayPayment[]> {
    const body = await this.request<{ items?: RazorpayPayment[] }>(
      "GET",
      `/orders/${encodeURIComponent(orderId)}/payments`,
    );
    return body.items ?? [];
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    if (!this.isConfigured) throw new RazorpayGatewayError("Razorpay is not configured");
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.keyId}:${this.keySecret}`).toString("base64")}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Razorpay ${method} ${path} failed: ${reason}`);
      throw new RazorpayGatewayError(`Could not reach Razorpay: ${reason}`);
    }

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = {};
    }
    if (!response.ok) {
      const error = (parsed as RazorpayErrorBody).error;
      this.logger.warn(`Razorpay ${method} ${path} → ${response.status} ${error?.code ?? ""} ${error?.description ?? ""}`);
      throw new RazorpayGatewayError(
        error?.description || `Razorpay responded ${response.status}`,
        response.status,
        error?.code,
      );
    }
    return parsed as T;
  }
}
