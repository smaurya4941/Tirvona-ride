import { Injectable, Logger } from "@nestjs/common";
import type { OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { RideDispatchService } from "./ride-dispatch.service";

/**
 * Periodic safety net behind the reactive dispatch (per-ride deadline timers
 * and kick-on-driver-available in RideDispatchService): re-matches open
 * searches and applies overdue timeouts after restarts or missed timers.
 * Every sweep step is idempotent, so running it on several instances is safe.
 */
@Injectable()
export class RideDispatchScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(RideDispatchScheduler.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly dispatch: RideDispatchService,
    private readonly config: ConfigService,
  ) {}

  onApplicationBootstrap(): void {
    const intervalMs = this.config.getOrThrow<number>("matchingSweepIntervalMs");
    if (intervalMs <= 0) {
      this.logger.warn("Dispatch sweep disabled (MATCHING_SWEEP_INTERVAL_MS=0)");
      return;
    }
    this.timer = setInterval(() => void this.tick(), intervalMs);
    // Never keep the process alive just for the sweep.
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    // Skip rather than overlap if a sweep outlives the interval.
    if (this.running) return;
    this.running = true;
    try {
      await this.dispatch.sweep();
    } catch (error) {
      this.logger.error("Dispatch sweep failed", error instanceof Error ? error.stack : String(error));
    } finally {
      this.running = false;
    }
  }
}
