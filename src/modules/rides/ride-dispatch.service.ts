import { Injectable, Logger } from "@nestjs/common";
import type { OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectModel } from "@nestjs/mongoose";
import type { Model, Types } from "mongoose";
import { MatchingService } from "../matching/matching.service";
import { Vehicle } from "../vehicles/schemas/vehicle.schema";
import { RideActorType, RideStatus } from "./ride-state-machine";
import { RideTransitionService } from "./ride-transition.service";
import type { RideActor } from "./ride-transition.service";
import { Ride } from "./schemas/ride.schema";
import type { RideDocument, RideVehicle } from "./schemas/ride.schema";

const SYSTEM: RideActor = { type: RideActorType.SYSTEM };
const CANDIDATES_PER_ATTEMPT = 5;
const SWEEP_BATCH = 50;

export type AssignmentEndReason = "DRIVER_REJECTED" | "ASSIGNMENT_TIMEOUT" | "DRIVER_OFFLINE";

const isDuplicateKey = (error: unknown): boolean =>
  (error as { code?: number } | undefined)?.code === 11000;

/**
 * Ride-side half of dispatch: puts a SEARCHING ride in front of the nearest
 * eligible driver, takes it back when that driver rejects / ignores it /
 * goes offline, and gives up after the search window.
 *
 * Every step is a compare-and-set, so running it from request handlers, the
 * background sweep, and several API instances at once is safe.
 */
@Injectable()
export class RideDispatchService implements OnModuleDestroy {
  private readonly logger = new Logger(RideDispatchService.name);
  private readonly assignmentTimeoutMs: number;
  private readonly reactive: boolean;
  /** Per-ride deadline timers, keyed "<rideId>:search" / "<rideId>:assignment". */
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private kickPending = false;

  constructor(
    @InjectModel(Ride.name) private readonly rideModel: Model<Ride>,
    @InjectModel(Vehicle.name) private readonly vehicleModel: Model<Vehicle>,
    private readonly matching: MatchingService,
    private readonly transitions: RideTransitionService,
    config: ConfigService,
  ) {
    this.assignmentTimeoutMs = config.getOrThrow<number>("rideAssignmentTimeoutSeconds") * 1000;
    this.reactive = config.getOrThrow<boolean>("matchingReactiveDispatch");
  }

  onModuleDestroy(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  // ── Reactive dispatch (Phase 3) ───────────────────────────────────────
  // Timeouts fire at their deadline instead of on the next sweep, so an
  // unanswered offer moves on (and its card disappears) on time. The
  // periodic sweep stays as the safety net for restarts and missed timers.

  /** Applies the ride's overdue search/assignment timeout at `at`. */
  scheduleDeadline(rideId: Types.ObjectId, kind: "search" | "assignment", at: Date): void {
    if (!this.reactive) return;
    const key = `${rideId.toString()}:${kind}`;
    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing);
    // A small grace so the guard `expiresAt <= now` is true when it runs.
    const delay = Math.max(0, at.getTime() - Date.now()) + 250;
    const timer = setTimeout(() => {
      this.timers.delete(key);
      void this.safely(async () => {
        const ride = await this.rideModel.findById(rideId).exec();
        if (ride) await this.settle(ride);
      });
    }, delay);
    timer.unref();
    this.timers.set(key, timer);
  }

  /**
   * A driver just became free (went online, finished or dropped a ride):
   * offer them the oldest open searches now rather than on the next sweep.
   * Coalesced so a burst of releases runs one pass.
   */
  kick(): void {
    if (!this.reactive || this.kickPending) return;
    this.kickPending = true;
    setImmediate(() => {
      this.kickPending = false;
      void this.safely(() => this.dispatchOpenSearches());
    });
  }

  /**
   * One matching attempt. Returns the ride in its resulting state (still
   * SEARCHING when nobody suitable is free right now).
   */
  async dispatch(rideId: Types.ObjectId): Promise<RideDocument | null> {
    const ride = await this.rideModel.findById(rideId).exec();
    if (!ride || ride.status !== RideStatus.SEARCHING) return ride;
    if (ride.searchExpiresAt.getTime() <= Date.now()) return this.expireSearch(ride._id);

    const candidates = await this.matching.findCandidates({
      pickup: ride.pickup,
      vehicleType: ride.vehicleType,
      excludeDriverIds: ride.rejectedDriverIds,
      limit: CANDIDATES_PER_ATTEMPT,
    });

    for (const candidate of candidates) {
      if (!(await this.matching.reserve(candidate.driverId, ride._id))) continue;

      try {
        const now = new Date();
        const assigned = await this.transitions.apply({
          rideId: ride._id,
          from: RideStatus.SEARCHING,
          to: RideStatus.DRIVER_ASSIGNED,
          set: {
            driverId: candidate.driverId,
            driverUserId: candidate.userId,
            vehicle: await this.vehicleSnapshot(candidate.activeVehicleId),
            driverDistanceMeters: Math.round(candidate.distanceMeters),
            assignedAt: now,
            assignmentExpiresAt: new Date(now.getTime() + this.assignmentTimeoutMs),
          },
          inc: { dispatchCount: 1 },
          actor: SYSTEM,
          metadata: {
            driverId: candidate.driverId.toString(),
            driverDistanceMeters: Math.round(candidate.distanceMeters),
          },
        });
        if (assigned) {
          if (assigned.assignmentExpiresAt)
            this.scheduleDeadline(assigned._id, "assignment", assigned.assignmentExpiresAt);
          return assigned;
        }
      } catch (error) {
        // uniq_active_ride_per_driver: the reservation guard should make this
        // unreachable; if it fires, skip the driver rather than fail dispatch.
        if (!isDuplicateKey(error)) {
          await this.matching.release(candidate.driverId, ride._id);
          throw error;
        }
        this.logger.warn(`Driver ${candidate.driverId.toString()} already holds an active ride`);
      }

      // The ride moved on (e.g. customer cancelled) between read and write.
      await this.matching.release(candidate.driverId, ride._id);
      return this.rideModel.findById(ride._id).exec();
    }
    return ride;
  }

  /**
   * DRIVER_ASSIGNED → SEARCHING for the given driver, remembering them so the
   * ride is not offered to them again, then immediately tries the next
   * driver. Returns null if the ride was no longer assigned to that driver.
   */
  async endAssignment(
    rideId: Types.ObjectId,
    driverId: Types.ObjectId,
    reason: AssignmentEndReason,
    actor: RideActor,
    note?: string,
  ): Promise<RideDocument | null> {
    const where =
      reason === "ASSIGNMENT_TIMEOUT"
        ? { driverId, assignmentExpiresAt: { $lte: new Date() } }
        : { driverId };
    const returned = await this.transitions.apply({
      rideId,
      from: RideStatus.DRIVER_ASSIGNED,
      to: RideStatus.SEARCHING,
      where,
      unset: ["driverId", "driverUserId", "vehicle", "driverDistanceMeters", "assignedAt", "assignmentExpiresAt"],
      addToSet: { rejectedDriverIds: driverId },
      actor,
      reason: note ? `${reason}: ${note}` : reason,
      metadata: { driverId: driverId.toString() },
    });
    if (!returned) return null;

    await this.matching.release(driverId, rideId);
    return (await this.dispatch(rideId)) ?? returned;
  }

  async expireSearch(rideId: Types.ObjectId): Promise<RideDocument | null> {
    const expired = await this.transitions.apply({
      rideId,
      from: RideStatus.SEARCHING,
      to: RideStatus.NO_DRIVER_AVAILABLE,
      where: { searchExpiresAt: { $lte: new Date() } },
      set: { expiredAt: new Date() },
      actor: SYSTEM,
      reason: "SEARCH_TIMEOUT",
    });
    return expired ?? this.rideModel.findById(rideId).exec();
  }

  /**
   * Lazily applies any overdue timeout to a ride that is being read, so
   * polling clients see correct state even between sweeps.
   */
  async settle(ride: RideDocument): Promise<RideDocument> {
    const now = Date.now();
    if (ride.status === RideStatus.SEARCHING && ride.searchExpiresAt.getTime() <= now)
      return (await this.expireSearch(ride._id)) ?? ride;
    if (
      ride.status === RideStatus.DRIVER_ASSIGNED &&
      ride.driverId &&
      ride.assignmentExpiresAt &&
      ride.assignmentExpiresAt.getTime() <= now
    )
      return (
        (await this.endAssignment(ride._id, ride.driverId, "ASSIGNMENT_TIMEOUT", SYSTEM)) ??
        (await this.rideModel.findById(ride._id).exec()) ??
        ride
      );
    return ride;
  }

  /** Background pass: timeouts first, then re-try every open search. */
  async sweep(): Promise<void> {
    const now = new Date();

    const staleAssignments = await this.rideModel
      .find({ status: RideStatus.DRIVER_ASSIGNED, assignmentExpiresAt: { $lte: now } })
      .limit(SWEEP_BATCH)
      .exec();
    for (const ride of staleAssignments)
      if (ride.driverId)
        await this.safely(() =>
          this.endAssignment(ride._id, ride.driverId!, "ASSIGNMENT_TIMEOUT", SYSTEM),
        );

    const expiredSearches = await this.rideModel
      .find({ status: RideStatus.SEARCHING, searchExpiresAt: { $lte: now } })
      .select("_id")
      .limit(SWEEP_BATCH)
      .exec();
    for (const ride of expiredSearches) await this.safely(() => this.expireSearch(ride._id));

    await this.dispatchOpenSearches();
  }

  private async dispatchOpenSearches(): Promise<void> {
    const openSearches = await this.rideModel
      .find({ status: RideStatus.SEARCHING, searchExpiresAt: { $gt: new Date() } })
      .sort({ requestedAt: 1 })
      .select("_id")
      .limit(SWEEP_BATCH)
      .exec();
    for (const ride of openSearches) await this.safely(() => this.dispatch(ride._id));
  }

  private async vehicleSnapshot(vehicleId?: Types.ObjectId): Promise<RideVehicle | undefined> {
    if (!vehicleId) return undefined;
    const vehicle = await this.vehicleModel.findById(vehicleId).exec();
    if (!vehicle) return undefined;
    return {
      vehicleId: vehicle._id,
      vehicleType: vehicle.vehicleType,
      registrationNumber: vehicle.registrationNumber,
      make: vehicle.make,
      model: vehicle.vehicleModel,
      color: vehicle.color,
    };
  }

  private async safely(step: () => Promise<unknown>): Promise<void> {
    try {
      await step();
    } catch (error) {
      this.logger.error(
        "Dispatch sweep step failed",
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
