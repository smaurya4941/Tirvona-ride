import { Injectable, Logger } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import type { Model } from "mongoose";
import { Types } from "mongoose";
import type { RideActor } from "../rides/ride-transition.service";
import { CircuitRideEvent } from "./schemas/circuit-ride-event.schema";

export interface CircuitLedgerEntry {
  rideId: Types.ObjectId;
  type: string;
  actor: RideActor;
  stopOrder?: number;
  fromState?: string;
  toState?: string;
  note?: string;
  data?: Record<string, unknown>;
}

export interface CircuitLedgerView {
  id: string;
  type: string;
  actorType: string;
  actorId?: string;
  stopOrder?: number;
  fromState?: string;
  toState?: string;
  note?: string;
  data?: Record<string, unknown>;
  at: Date;
}

/** Append-only record of what happened inside circuits: who, what, when, from which state to which. */
@Injectable()
export class CircuitLedgerService {
  private readonly logger = new Logger(CircuitLedgerService.name);

  constructor(@InjectModel(CircuitRideEvent.name) private readonly events: Model<CircuitRideEvent>) {}

  /** The change has already committed; a failed audit insert is logged loudly but never fails the action. */
  async record(entry: CircuitLedgerEntry): Promise<void> {
    try {
      await this.events.create({
        rideId: entry.rideId,
        type: entry.type,
        actorType: entry.actor.type,
        actorId: entry.actor.userId ? new Types.ObjectId(entry.actor.userId) : undefined,
        stopOrder: entry.stopOrder,
        fromState: entry.fromState,
        toState: entry.toState,
        note: entry.note,
        data: entry.data,
      });
    } catch (error) {
      this.logger.error(
        `Failed to record circuit event ${entry.type} for ride ${entry.rideId.toString()}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  async timeline(rideId: Types.ObjectId): Promise<CircuitLedgerView[]> {
    const rows = await this.events.find({ rideId }).sort({ createdAt: 1, _id: 1 }).lean().exec();
    return rows.map((row) => ({
      id: row._id.toString(),
      type: row.type,
      actorType: row.actorType,
      actorId: row.actorId?.toString(),
      stopOrder: row.stopOrder,
      fromState: row.fromState,
      toState: row.toState,
      note: row.note,
      data: row.data,
      at: (row as unknown as { createdAt: Date }).createdAt,
    }));
  }
}
