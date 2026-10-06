import { Injectable, Logger } from "@nestjs/common";
import type { OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { EarningsService } from "../earnings/earnings.service";
import { PaymentEventSource } from "./interfaces/payment-status";
import { PaymentReconciliationService } from "./payment-reconciliation.service";
import { PaymentsService } from "./payments.service";
import { RefundsService } from "./refunds.service";

const BATCH = 25;
/** Refunds are re-checked with Razorpay at most this often. */
const REFUND_CHECK_MS = 2 * 60_000;
/** Open orders nobody told us about are re-checked at most this often… */
const OPEN_ORDER_CHECK_MS = 30 * 60_000;
/** …for this long after the order was raised. */
const OPEN_ORDER_HORIZON_MS = 3 * 86_400_000;

export interface ReconcilerPass {
  reconciled: number;
  earningsRecorded: number;
  promoted: number;
  refundsChecked: number;
  clawbacks: number;
  openOrdersChecked: number;
  dailyRunStarted: boolean;
}

/**
 * Safety net behind /verify and the webhook, on a timer:
 *  - payments Razorpay may have settled while neither path reached us
 *    (app killed mid-checkout + webhook lost) are re-checked with Razorpay —
 *    those we know are in flight quickly, other open orders every 30 min;
 *  - captured payments whose earning insert failed get their earning;
 *  - earnings whose settlement window ended become AVAILABLE;
 *  - refunds Razorpay has not finished (or never confirmed) are re-checked;
 *  - processed refunds whose driver clawback is missing get it;
 *  - once a day, yesterday is reconciled end to end against Razorpay.
 * Every step is idempotent, so overlapping instances are harmless.
 */
@Injectable()
export class PaymentsReconciler
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(PaymentsReconciler.name);
  private readonly intervalMs: number;
  private readonly staleMs: number;
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly payments: PaymentsService,
    private readonly earnings: EarningsService,
    private readonly refunds: RefundsService,
    private readonly reconciliation: PaymentReconciliationService,
    config: ConfigService,
  ) {
    this.intervalMs = config.getOrThrow<number>("paymentReconcileIntervalMs");
    this.staleMs =
      config.getOrThrow<number>("paymentProcessingStaleSeconds") * 1000;
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
  async runOnce(now = new Date()): Promise<ReconcilerPass> {
    const pass: ReconcilerPass = {
      reconciled: 0,
      earningsRecorded: 0,
      promoted: 0,
      refundsChecked: 0,
      clawbacks: 0,
      openOrdersChecked: 0,
      dailyRunStarted: false,
    };
    if (this.running) return pass;
    this.running = true;
    try {
      for (const payment of await this.payments.findStaleProcessing(
        new Date(now.getTime() - this.staleMs),
        BATCH,
      )) {
        const before = payment.status;
        const after = await this.payments.reconcile(
          payment,
          PaymentEventSource.RECONCILE,
        );
        if (after.status !== before) pass.reconciled += 1;
      }
      for (const payment of await this.payments.findOpenOrdersToCheck(
        new Date(now.getTime() - OPEN_ORDER_CHECK_MS),
        new Date(now.getTime() - OPEN_ORDER_HORIZON_MS),
        BATCH,
      )) {
        pass.openOrdersChecked += 1;
        const before = payment.status;
        const after = await this.payments.reconcile(
          payment,
          PaymentEventSource.RECONCILE,
        );
        if (after.status !== before) pass.reconciled += 1;
      }
      for (const payment of await this.payments.findCapturedWithoutEarning(
        BATCH,
      )) {
        await this.payments.afterCapture(payment);
        if (payment.earningId) pass.earningsRecorded += 1;
      }
      pass.promoted = await this.earnings.promoteMatured();

      for (const refund of await this.refunds.findUnsettled(
        new Date(now.getTime() - REFUND_CHECK_MS),
        BATCH,
      )) {
        await this.refunds.resolve(refund, PaymentEventSource.RECONCILE);
        pass.refundsChecked += 1;
      }
      for (const refund of await this.refunds.findLedgerPending(BATCH)) {
        await this.refunds.applyLedger(refund);
        pass.clawbacks += 1;
      }
      pass.dailyRunStarted = await this.reconciliation.ensureDailyRun(now);

      if (
        pass.reconciled ||
        pass.earningsRecorded ||
        pass.promoted ||
        pass.refundsChecked ||
        pass.clawbacks
      )
        this.logger.log(
          `Reconciled ${pass.reconciled} payments, recorded ${pass.earningsRecorded} earnings, released ${pass.promoted}, ` +
            `checked ${pass.refundsChecked} refunds, ${pass.clawbacks} clawbacks`,
        );
    } catch (error) {
      this.logger.error(
        "Payment reconciliation pass failed",
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      this.running = false;
    }
    return pass;
  }
}
