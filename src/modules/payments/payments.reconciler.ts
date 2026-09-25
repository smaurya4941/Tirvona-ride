import { Injectable, Logger } from "@nestjs/common";
import type { OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { EarningsService } from "../earnings/earnings.service";
import { PaymentEventSource } from "./interfaces/payment-status";
import { PaymentsService } from "./payments.service";

const BATCH = 25;

/**
 * Safety net behind /verify and the webhook, on a timer:
 *  - payments Razorpay may have settled while neither path reached us
 *    (app killed mid-checkout + webhook lost) are re-checked with Razorpay;
 *  - captured payments whose earning insert failed get their earning;
 *  - earnings whose settlement window ended become AVAILABLE.
 * Every step is idempotent, so overlapping instances are harmless.
 */
@Injectable()
export class PaymentsReconciler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(PaymentsReconciler.name);
  private readonly intervalMs: number;
  private readonly staleMs: number;
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly payments: PaymentsService,
    private readonly earnings: EarningsService,
    config: ConfigService,
  ) {
    this.intervalMs = config.getOrThrow<number>("paymentReconcileIntervalMs");
    this.staleMs = config.getOrThrow<number>("paymentProcessingStaleSeconds") * 1000;
  }

  onApplicationBootstrap(): void {
    if (this.intervalMs <= 0) return;
    this.timer = setInterval(() => void this.runOnce(), this.intervalMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One pass. Public so tests and ops tooling can drive it directly. */
  async runOnce(): Promise<{ reconciled: number; earningsRecorded: number; promoted: number }> {
    if (this.running) return { reconciled: 0, earningsRecorded: 0, promoted: 0 };
    this.running = true;
    let reconciled = 0;
    let earningsRecorded = 0;
    let promoted = 0;
    try {
      for (const payment of await this.payments.findStaleProcessing(new Date(Date.now() - this.staleMs), BATCH)) {
        const before = payment.status;
        const after = await this.payments.reconcile(payment, PaymentEventSource.RECONCILE);
        if (after.status !== before) reconciled += 1;
      }
      for (const payment of await this.payments.findCapturedWithoutEarning(BATCH)) {
        await this.payments.afterCapture(payment);
        if (payment.earningId) earningsRecorded += 1;
      }
      promoted = await this.earnings.promoteMatured();
      if (reconciled || earningsRecorded || promoted)
        this.logger.log(`Reconciled ${reconciled} payments, recorded ${earningsRecorded} earnings, released ${promoted}`);
    } catch (error) {
      this.logger.error("Payment reconciliation pass failed", error instanceof Error ? error.stack : String(error));
    } finally {
      this.running = false;
    }
    return { reconciled, earningsRecorded, promoted };
  }
}
