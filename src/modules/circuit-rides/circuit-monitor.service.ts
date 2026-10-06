import { Injectable, Logger } from "@nestjs/common";
import type {
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectModel } from "@nestjs/mongoose";
import type { Model } from "mongoose";
import { DriverLocationService } from "../locations/driver-location.service";
import { measureTrip } from "../pricing/trip-meter";
import { RideEventsService } from "../rides/ride-events.service";
import { RideActorType, RideStatus } from "../rides/ride-state-machine";
import { Ride } from "../rides/schemas/ride.schema";
import type { RideDocument } from "../rides/schemas/ride.schema";
import { CircuitLedgerService } from "./circuit-ledger.service";
import { dueWarnings } from "./circuit-pricing";
import type { UsageWarning } from "./circuit-pricing";
import { elapsedSeconds } from "./circuit-view";
import { CircuitEvent, RideKind } from "./circuit-ride.types";
import type { CircuitNoticeKind } from "../../infrastructure/events/domain-events";

const BATCH = 200;

/** Which flag records each warning, so it is sent once per circuit. */
const WARNING_FLAG: Record<UsageWarning, string> = {
  TIME_30_MIN: "time30At",
  TIME_10_MIN: "time10At",
  TIME_EXHAUSTED: "timeExhaustedAt",
  DISTANCE_80: "distance80At",
  DISTANCE_EXHAUSTED: "distanceExhaustedAt",
};

export interface MonitorResult {
  checked: number;
  warnings: number;
}

/**
 * Watches running circuits. Each pass measures the distance travelled from the
 * GPS trail, tells both apps the new usage, and sends the time and distance
 * warnings (30 and 10 minutes left, 80% and 100% of the included distance) —
 * each exactly once per circuit, whichever instance gets there first (a
 * conditional update on the warning's flag decides). Safe to run on several
 * instances; a missed pass only delays a warning to the next.
 */
@Injectable()
export class CircuitMonitorService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(CircuitMonitorService.name);
  private readonly tripMeterMaxGapSeconds: number;
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    @InjectModel(Ride.name) private readonly rideModel: Model<Ride>,
    private readonly locations: DriverLocationService,
    private readonly events: RideEventsService,
    private readonly ledger: CircuitLedgerService,
    private readonly config: ConfigService,
  ) {
    this.tripMeterMaxGapSeconds = config.getOrThrow<number>(
      "tripMeterMaxGapSeconds",
    );
  }

  onApplicationBootstrap(): void {
    const intervalMs = this.config.getOrThrow<number>(
      "circuitMonitorIntervalMs",
    );
    if (intervalMs <= 0) {
      this.logger.warn(
        "Circuit monitor disabled (CIRCUIT_MONITOR_INTERVAL_MS=0)",
      );
      return;
    }
    this.timer = setInterval(() => void this.safeTick(), intervalMs);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async safeTick(): Promise<void> {
    // Skip rather than overlap if a pass outlives the interval.
    if (this.running) return;
    this.running = true;
    try {
      await this.tick();
    } catch (error) {
      this.logger.error(
        "Circuit monitor pass failed",
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      this.running = false;
    }
  }

  /** One pass over every running circuit. */
  async tick(now: Date = new Date()): Promise<MonitorResult> {
    const running = await this.rideModel
      .find({ kind: RideKind.CIRCUIT, status: RideStatus.RIDE_STARTED })
      .limit(BATCH)
      .exec();
    let warnings = 0;
    for (const ride of running) {
      try {
        warnings += await this.check(ride, now);
      } catch (error) {
        this.logger.error(
          `Circuit check failed for ${ride.rideCode}`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }
    return { checked: running.length, warnings };
  }

  private async check(ride: RideDocument, now: Date): Promise<number> {
    const circuit = ride.circuit;
    if (!circuit || !ride.driverId || !ride.startedAt) return 0;

    const measurement = measureTrip(
      await this.locations.tripTrail(ride._id, ride.driverId, ride.startedAt),
      this.tripMeterMaxGapSeconds,
    );
    // Distance never goes backwards (an unreliable trail must not erase what was already measured).
    const distance = Math.max(
      circuit.usage?.distanceMeters ?? 0,
      measurement.distanceMeters,
    );
    const refreshed = await this.rideModel
      .findOneAndUpdate(
        { _id: ride._id, status: RideStatus.RIDE_STARTED },
        {
          $set: {
            "circuit.usage.distanceMeters": distance,
            "circuit.usage.reliable": measurement.reliable,
            "circuit.usage.measuredAt": now,
          },
          $inc: { stateVersion: 1 },
        },
        { returnDocument: "after" },
      )
      .exec();
    if (!refreshed) return 0;

    const elapsed = elapsedSeconds(ride.startedAt, undefined, now);
    let sent = 0;
    for (const warning of dueWarnings(circuit.pricing, distance, elapsed)) {
      const flag = WARNING_FLAG[warning];
      const claimed = await this.rideModel
        .findOneAndUpdate(
          {
            _id: ride._id,
            status: RideStatus.RIDE_STARTED,
            [`circuit.warnings.${flag}`]: { $exists: false },
          },
          {
            $set: { [`circuit.warnings.${flag}`]: now },
            $inc: { stateVersion: 1 },
          },
          { returnDocument: "after" },
        )
        .exec();
      if (!claimed) continue;
      sent += 1;
      const remainingSeconds =
        circuit.pricing.includedDurationSeconds - elapsed;
      const isTime = warning.startsWith("TIME");
      await this.ledger.record({
        rideId: ride._id,
        type: "WARNING",
        actor: { type: RideActorType.SYSTEM },
        data: { warning, distanceMeters: distance, elapsedSeconds: elapsed },
      });
      this.events.circuitEvent(
        claimed,
        isTime ? CircuitEvent.TIME_WARNING : CircuitEvent.DISTANCE_WARNING,
        { warning, remainingSeconds, distanceMeters: distance },
        {
          kind: warning as CircuitNoticeKind,
          remainingMinutes: Math.max(0, Math.round(remainingSeconds / 60)),
        },
      );
    }
    if (sent === 0)
      this.events.circuitEvent(refreshed, CircuitEvent.USAGE, {
        distanceMeters: distance,
      });
    return sent;
  }
}
