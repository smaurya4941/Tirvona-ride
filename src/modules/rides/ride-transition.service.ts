import { Injectable, Logger } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import type { Model, QueryFilter, UpdateQuery } from "mongoose";
import { Types } from "mongoose";
import { RideEventsService } from "./ride-events.service";
import { assertTransition, isTerminal } from "./ride-state-machine";
import type { RideActorType, RideStatus } from "./ride-state-machine";
import { Ride } from "./schemas/ride.schema";
import type { RideDocument } from "./schemas/ride.schema";
import { RideStatusHistory } from "./schemas/ride-status-history.schema";
import type { RideStatusHistoryDocument } from "./schemas/ride-status-history.schema";

export interface RideActor {
  type: RideActorType;
  userId?: Types.ObjectId | string;
}

export interface TransitionCommand {
  rideId: Types.ObjectId;
  from: RideStatus;
  to: RideStatus;
  /** Extra guard conditions, e.g. `{ driverId }` for ownership. */
  where?: QueryFilter<Ride>;
  set?: Record<string, unknown>;
  unset?: string[];
  addToSet?: Record<string, unknown>;
  inc?: Record<string, number>;
  actor: RideActor;
  reason?: string;
  metadata?: Record<string, unknown>;
}

const toObjectId = (id?: Types.ObjectId | string): Types.ObjectId | undefined =>
  id === undefined ? undefined : typeof id === "string" ? new Types.ObjectId(id) : id;

/**
 * The single place a ride's status is written.
 *
 * Each transition is one conditional `findOneAndUpdate` on
 * `{ _id, status: from, ...where }` — a compare-and-set. If two requests race
 * (two drivers accepting, a driver accepting while the customer cancels, the
 * sweeper expiring an assignment the driver is accepting), MongoDB's
 * per-document atomicity guarantees exactly one wins; the loser gets `null`
 * and the caller turns that into a 409.
 *
 * Because it is the single write point, it is also the single place realtime
 * ride events originate (see RideEventsService).
 */
@Injectable()
export class RideTransitionService {
  private readonly logger = new Logger(RideTransitionService.name);

  constructor(
    @InjectModel(Ride.name) private readonly rideModel: Model<Ride>,
    @InjectModel(RideStatusHistory.name)
    private readonly historyModel: Model<RideStatusHistory>,
    private readonly events: RideEventsService,
  ) {}

  async apply(command: TransitionCommand): Promise<RideDocument | null> {
    assertTransition(command.from, command.to);

    const update: Record<string, unknown> = {
      $set: { ...command.set, status: command.to, isActive: !isTerminal(command.to) },
    };
    if (command.unset?.length)
      update.$unset = Object.fromEntries(command.unset.map((path) => [path, 1]));
    if (command.addToSet) update.$addToSet = command.addToSet;
    update.$inc = { ...command.inc, stateVersion: 1 };

    const ride = await this.rideModel
      .findOneAndUpdate(
        { ...command.where, _id: command.rideId, status: command.from },
        update as UpdateQuery<Ride>,
        { returnDocument: "after", runValidators: true },
      )
      .exec();
    if (!ride) return null;

    await this.record({
      rideId: ride._id,
      fromStatus: command.from,
      toStatus: command.to,
      actor: command.actor,
      reason: command.reason,
      metadata: command.metadata,
    });
    // After the commit: the event means "this already happened".
    this.events.transitioned({
      ride,
      from: command.from,
      to: command.to,
      reason: command.reason,
      metadata: command.metadata,
    });
    return ride;
  }

  /**
   * The status change has already committed; a failed audit insert is
   * logged loudly but must not turn a successful ride action into a 500.
   */
  async record(entry: {
    rideId: Types.ObjectId;
    fromStatus?: RideStatus;
    toStatus: RideStatus;
    actor: RideActor;
    reason?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    try {
      await this.historyModel.create({
        rideId: entry.rideId,
        fromStatus: entry.fromStatus,
        toStatus: entry.toStatus,
        actorType: entry.actor.type,
        actorId: toObjectId(entry.actor.userId),
        reason: entry.reason,
        metadata: entry.metadata,
      });
    } catch (error) {
      this.logger.error(
        `Failed to record ride history ${entry.rideId.toString()} ${entry.fromStatus ?? "∅"} → ${entry.toStatus}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  async history(rideId: Types.ObjectId): Promise<RideStatusHistoryDocument[]> {
    return this.historyModel.find({ rideId }).sort({ createdAt: 1, _id: 1 }).exec();
  }
}
