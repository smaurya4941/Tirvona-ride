import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectModel } from "@nestjs/mongoose";
import type { Model } from "mongoose";
import { createHash } from "node:crypto";
import { ApiException, apiBadRequest } from "../../common/exceptions/api.exception";
import { PaymentEventSource } from "./interfaces/payment-status";
import { PaymentsService } from "./payments.service";
import { verifyWebhookSignature } from "./razorpay/razorpay-signature";
import type { RazorpayPayment, RazorpayRefund, RazorpayWebhookBody } from "./razorpay/razorpay.types";
import { PaymentWebhookEvent, WebhookEventStatus } from "./schemas/payment-webhook-event.schema";

export interface WebhookResult {
  status: WebhookEventStatus | "DUPLICATE";
  event?: string;
}

// Events Tirvona acts on. Configure these on the Razorpay dashboard webhook.
const HANDLED_EVENTS = new Set([
  "payment.authorized",
  "payment.captured",
  "payment.failed",
  "order.paid",
  "refund.processed",
  "refund.failed",
]);

/**
 * Server-to-server confirmation from Razorpay — the second, independent
 * path to a settled payment besides /payments/verify (which depends on the
 * app surviving the checkout). Signature-checked over the raw body,
 * de-duplicated by Razorpay's event id, and routed into the same
 * compare-and-set settlement as /verify, so a redelivered or reordered
 * event can never double-count anything.
 */
@Injectable()
export class PaymentWebhookService {
  private readonly logger = new Logger(PaymentWebhookService.name);
  private readonly webhookSecret: string;

  constructor(
    @InjectModel(PaymentWebhookEvent.name) private readonly eventModel: Model<PaymentWebhookEvent>,
    private readonly payments: PaymentsService,
    config: ConfigService,
  ) {
    this.webhookSecret = config.get<string>("razorpayWebhookSecret") ?? "";
  }

  async handle(rawBody: Buffer | undefined, signature: string | undefined, eventIdHeader?: string): Promise<WebhookResult> {
    if (!this.webhookSecret)
      // 503 → Razorpay keeps retrying until the secret is configured.
      throw new ApiException(
        HttpStatus.SERVICE_UNAVAILABLE,
        "Webhook secret is not configured",
        "PAYMENT_GATEWAY_NOT_CONFIGURED",
      );
    if (!rawBody?.length) throw apiBadRequest("Empty webhook body", "PAYMENT_WEBHOOK_INVALID");
    if (!verifyWebhookSignature(rawBody, signature, this.webhookSecret)) {
      this.logger.warn("Rejected a webhook with an invalid signature");
      throw apiBadRequest("Invalid webhook signature", "PAYMENT_WEBHOOK_INVALID");
    }

    let body: RazorpayWebhookBody;
    try {
      body = JSON.parse(rawBody.toString("utf8")) as RazorpayWebhookBody;
    } catch {
      throw apiBadRequest("Webhook body is not JSON", "PAYMENT_WEBHOOK_INVALID");
    }
    if (typeof body?.event !== "string" || typeof body.payload !== "object" || body.payload === null)
      throw apiBadRequest("Unrecognised webhook body", "PAYMENT_WEBHOOK_INVALID");

    const eventId = eventIdHeader?.trim() || `sha256:${createHash("sha256").update(rawBody).digest("hex")}`;
    const paymentEntity = body.payload.payment?.entity;
    const refundEntity = body.payload.refund?.entity;

    // Claim the event. A redelivery of one already handled is a no-op;
    // one whose earlier processing failed is processed again.
    const previous = await this.eventModel
      .findOneAndUpdate(
        { eventId },
        {
          $setOnInsert: {
            eventId,
            event: body.event,
            status: WebhookEventStatus.RECEIVED,
            razorpayOrderId: paymentEntity?.order_id ?? body.payload.order?.entity.id,
            razorpayPaymentId: paymentEntity?.id ?? refundEntity?.payment_id,
          },
          $inc: { deliveries: 1 },
        },
        { upsert: true, returnDocument: "before" },
      )
      .exec();
    if (previous && previous.status !== WebhookEventStatus.FAILED && previous.status !== WebhookEventStatus.RECEIVED)
      return { status: "DUPLICATE", event: body.event };

    let outcome: { status: WebhookEventStatus; detail?: string };
    try {
      outcome = await this.route(body);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (error instanceof ApiException && error.getStatus() < 500) {
        // Razorpay's facts contradict ours (amount/order mismatch, reused id):
        // retrying will not help — keep it for a human.
        outcome = { status: WebhookEventStatus.FLAGGED, detail };
        this.logger.error(`Webhook ${body.event} ${eventId} flagged: ${detail}`);
      } else {
        await this.mark(eventId, WebhookEventStatus.FAILED, detail);
        this.logger.error(`Webhook ${body.event} ${eventId} failed; Razorpay will retry`, (error as Error).stack);
        throw error;
      }
    }
    await this.mark(eventId, outcome.status, outcome.detail);
    return { status: outcome.status, event: body.event };
  }

  private async route(body: RazorpayWebhookBody): Promise<{ status: WebhookEventStatus; detail?: string }> {
    if (!HANDLED_EVENTS.has(body.event)) return { status: WebhookEventStatus.IGNORED, detail: "Unhandled event" };

    if (body.event.startsWith("refund.")) {
      const refund = body.payload.refund?.entity;
      if (!refund) return { status: WebhookEventStatus.IGNORED, detail: "No refund entity" };
      // Refund webhooks also carry the payment, whose amount_refunded is the
      // cumulative total across partial refunds.
      return this.onRefund(refund, body.event, body.payload.payment?.entity.amount_refunded);
    }

    const gatewayPayment = body.payload.payment?.entity;
    if (!gatewayPayment?.order_id)
      return { status: WebhookEventStatus.IGNORED, detail: "Payment without an order" };
    return this.onPayment(gatewayPayment);
  }

  private async onPayment(gatewayPayment: RazorpayPayment): Promise<{ status: WebhookEventStatus; detail?: string }> {
    const payment = await this.payments.findByOrderId(gatewayPayment.order_id!);
    // Not one of ours (e.g. another integration on the same Razorpay account).
    if (!payment) return { status: WebhookEventStatus.IGNORED, detail: "Unknown order" };
    const updated = await this.payments.applyGatewayPayment(payment, gatewayPayment, PaymentEventSource.WEBHOOK);
    return { status: WebhookEventStatus.PROCESSED, detail: `payment ${updated._id.toString()} → ${updated.status}` };
  }

  private async onRefund(
    refund: RazorpayRefund,
    event: string,
    cumulativeRefundedPaise?: number,
  ): Promise<{ status: WebhookEventStatus; detail?: string }> {
    const payment = await this.payments.findByRazorpayPaymentId(refund.payment_id);
    if (!payment) return { status: WebhookEventStatus.IGNORED, detail: "Unknown payment" };
    const updated = await this.payments.recordRefund(payment, {
      refundId: refund.id,
      amountPaise: cumulativeRefundedPaise ?? refund.amount,
      status: event === "refund.failed" ? "failed" : refund.status,
      source: PaymentEventSource.WEBHOOK,
    });
    return { status: WebhookEventStatus.PROCESSED, detail: `payment ${updated._id.toString()} → ${updated.status}` };
  }

  private async mark(eventId: string, status: WebhookEventStatus, detail?: string): Promise<void> {
    await this.eventModel
      .updateOne({ eventId }, { $set: { status, ...(detail ? { detail: detail.slice(0, 500) } : {}) } })
      .exec();
  }
}
