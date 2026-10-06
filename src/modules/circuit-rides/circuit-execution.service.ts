import { HttpStatus, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectModel } from "@nestjs/mongoose";
import type { Model } from "mongoose";
import { Types } from "mongoose";
import {
  ApiException,
  apiBadRequest,
  apiNotFound,
} from "../../common/exceptions/api.exception";
import { AuditLogService } from "../audit/audit-log.service";
import { haversineMeters } from "../locations/geo";
import { DriverLocationService } from "../locations/driver-location.service";
import { CheckpointKind } from "../locations/schemas/driver-location-checkpoint.schema";
import { MatchingService } from "../matching/matching.service";
import { measureTrip } from "../pricing/trip-meter";
import { RideDispatchService } from "../rides/ride-dispatch.service";
import { RideEventsService } from "../rides/ride-events.service";
import { RidePaymentStatus } from "../rides/ride-payment-status";
import { RideActorType, RideStatus } from "../rides/ride-state-machine";
import { RideTransitionService } from "../rides/ride-transition.service";
import type { RideActor } from "../rides/ride-transition.service";
import { RideViewService } from "../rides/ride-view.service";
import type { DriverRideView } from "../rides/ride-view.service";
import { RidesService } from "../rides/rides.service";
import { Ride } from "../rides/schemas/ride.schema";
import type { RideDocument, RideFinalFare } from "../rides/schemas/ride.schema";
import type { DriverProfileDocument } from "../drivers/schemas/driver-profile.schema";
import { CircuitLedgerService } from "./circuit-ledger.service";
import { calculateCircuitFare } from "./circuit-pricing";
import {
  CIRCUIT_STOP_DONE,
  CircuitEvent,
  CircuitExceptionResolution,
  CircuitExceptionType,
  CircuitStopStatus,
  RideKind,
  STOP_COMMANDS,
} from "./circuit-ride.types";
import type { StopCommand } from "./circuit-ride.types";

/** Progress of a stop, so a repeated command ("arrived" sent twice) is recognised as already done. */
const STOP_RANK: Record<CircuitStopStatus, number> = {
  [CircuitStopStatus.UPCOMING]: 0,
  [CircuitStopStatus.ARRIVING]: 1,
  [CircuitStopStatus.ARRIVED]: 2,
  [CircuitStopStatus.WAITING]: 3,
  [CircuitStopStatus.COMPLETED]: 4,
  [CircuitStopStatus.SKIPPED]: 4,
};

const SYSTEM_STATE_CONFLICT = "RIDE_STATE_CONFLICT" as const;

const conflict = (
  message: string,
  code: Parameters<typeof apiBadRequest>[1],
  data?: Record<string, unknown>,
): ApiException => new ApiException(HttpStatus.CONFLICT, message, code, data);

/**
 * Everything that happens to a circuit after it starts: stop progression, the
 * blocked-stop exception, completion with the final fare, and the admin
 * interventions. Every step is a compare-and-set on the ride, so a repeated
 * tap, a retry after a network drop or two instances racing can never move the
 * circuit twice. Drivers send commands; the backend decides whether they are
 * legal and owns the sequence — an app can never set a status, stop or fare.
 */
@Injectable()
export class CircuitExecutionService {
  private readonly arrivalRadiusMeters: number;
  private readonly tripMeterMaxGapSeconds: number;

  constructor(
    @InjectModel(Ride.name) private readonly rideModel: Model<Ride>,
    private readonly rides: RidesService,
    private readonly transitions: RideTransitionService,
    private readonly events: RideEventsService,
    private readonly views: RideViewService,
    private readonly matching: MatchingService,
    private readonly dispatch: RideDispatchService,
    private readonly locations: DriverLocationService,
    private readonly ledger: CircuitLedgerService,
    private readonly audit: AuditLogService,
    config: ConfigService,
  ) {
    this.arrivalRadiusMeters = config.getOrThrow<number>(
      "circuitStopArrivalRadiusMeters",
    );
    this.tripMeterMaxGapSeconds = config.getOrThrow<number>(
      "tripMeterMaxGapSeconds",
    );
  }

  // ── Driver commands ───────────────────────────────────────────────────

  arriveAtStop(
    driverUserId: string,
    rideId: string,
    order: number,
  ): Promise<DriverRideView> {
    return this.stopCommand(driverUserId, rideId, order, "ARRIVE");
  }

  /** The customer is visiting the stop: the driver waits (the included time keeps running). */
  waitAtStop(
    driverUserId: string,
    rideId: string,
    order: number,
  ): Promise<DriverRideView> {
    return this.stopCommand(driverUserId, rideId, order, "WAIT");
  }

  /** Done at this stop: it completes and the next stop becomes the one being driven to. */
  completeStop(
    driverUserId: string,
    rideId: string,
    order: number,
  ): Promise<DriverRideView> {
    return this.stopCommand(driverUserId, rideId, order, "COMPLETE");
  }

  /**
   * The stop cannot be reached or used. The driver cannot skip it or mark it done:
   * this opens an exception that only Admin resolves, and progress stops until then.
   */
  async reportStopBlocked(
    driverUserId: string,
    rideId: string,
    order: number,
    note?: string,
  ): Promise<DriverRideView> {
    const { driver, ride } = await this.loadForDriver(driverUserId, rideId);
    this.assertRunning(ride, "report a blocked stop on");
    const circuit = ride.circuit!;
    const stop = this.requireStop(ride, order);
    if (circuit.exception) {
      if (circuit.exception.stopOrder === order)
        return this.views.forDriver(ride, driver);
      throw conflict(
        "Another issue is already open on this circuit",
        "CIRCUIT_EXCEPTION_OPEN",
      );
    }
    if (
      order !== circuit.currentStopOrder ||
      (CIRCUIT_STOP_DONE as readonly string[]).includes(stop.status)
    )
      throw conflict(
        `Stop ${order} is not the stop you are working on`,
        "CIRCUIT_STOP_INVALID",
        { currentStopOrder: circuit.currentStopOrder },
      );

    const now = new Date();
    const updated = await this.rideModel
      .findOneAndUpdate(
        {
          _id: ride._id,
          driverId: driver._id,
          kind: RideKind.CIRCUIT,
          status: RideStatus.RIDE_STARTED,
          "circuit.currentStopOrder": order,
          "circuit.exception": { $exists: false },
        },
        {
          $set: {
            "circuit.exception": {
              type: CircuitExceptionType.STOP_BLOCKED,
              stopOrder: order,
              note,
              reportedAt: now,
              reportedBy: driver.userId,
            },
          },
          $inc: { stateVersion: 1 },
        },
        { returnDocument: "after" },
      )
      .exec();
    if (!updated) throw await this.explainFailure(ride._id, driver);

    const actor = this.driverActor(driver);
    await this.ledger.record({
      rideId: ride._id,
      type: "STOP_BLOCKED",
      actor,
      stopOrder: order,
      fromState: stop.status,
      note,
    });
    this.events.circuitEvent(
      updated,
      CircuitEvent.STOP_BLOCKED,
      { stopOrder: order, note },
      { kind: "STOP_BLOCKED", stopName: stop.name, stopOrder: order },
    );
    return this.views.forDriver(updated, driver);
  }

  /** All stops done: price the circuit on what it used, close the ride's trip and free the driver. */
  async completeCircuit(
    driverUserId: string,
    rideId: string,
  ): Promise<DriverRideView> {
    const { driver, ride } = await this.loadForDriver(driverUserId, rideId);
    // A repeated "complete" (the first response was lost) returns the finished circuit.
    if (ride.status === RideStatus.COMPLETED)
      return this.views.forDriver(ride, driver);
    this.assertRunning(ride, "complete");
    const circuit = ride.circuit!;
    if (circuit.exception)
      throw conflict(
        "Support must resolve the open issue first",
        "CIRCUIT_EXCEPTION_OPEN",
      );
    if (circuit.currentStopOrder <= circuit.stops.length)
      throw conflict(
        "Finish every stop before completing the circuit",
        "CIRCUIT_STOPS_REMAINING",
        {
          currentStopOrder: circuit.currentStopOrder,
          stops: circuit.stops.length,
        },
      );
    const completed = await this.finish(
      ride,
      this.driverActor(driver),
      "DRIVER",
    );
    return this.views.forDriver(completed, driver);
  }

  // ── Admin interventions ───────────────────────────────────────────────

  /** Resolve the open exception: carry on, or skip the stop (it is dropped from the bill's route, not the price). */
  async resolveException(
    adminId: string,
    rideId: string,
    resolution: CircuitExceptionResolution,
    note: string,
  ): Promise<RideDocument> {
    const ride = await this.requireCircuit(rideId);
    if (ride.status !== RideStatus.RIDE_STARTED || !ride.circuit?.exception)
      throw conflict("This circuit has no open issue", "CIRCUIT_NO_EXCEPTION");
    const exception = ride.circuit.exception;
    const order = exception.stopOrder;
    const stop = this.requireStop(ride, order);
    const actor: RideActor = { type: RideActorType.ADMIN, userId: adminId };
    const now = new Date();
    const base = {
      _id: ride._id,
      kind: RideKind.CIRCUIT,
      status: RideStatus.RIDE_STARTED,
      "circuit.exception.stopOrder": order,
    };

    let updated: RideDocument | null;
    let nextName: string | undefined;
    if (resolution === CircuitExceptionResolution.CONTINUE) {
      updated = await this.rideModel
        .findOneAndUpdate(
          base,
          { $unset: { "circuit.exception": 1 }, $inc: { stateVersion: 1 } },
          { returnDocument: "after" },
        )
        .exec();
    } else {
      const next = ride.circuit.stops.find(
        (candidate) => candidate.order === order + 1,
      );
      nextName = next?.name;
      updated = await this.rideModel
        .findOneAndUpdate(
          { ...base, "circuit.currentStopOrder": order },
          {
            $set: {
              "circuit.stops.$[cur].status": CircuitStopStatus.SKIPPED,
              "circuit.stops.$[cur].skippedAt": now,
              "circuit.currentStopOrder": order + 1,
              ...(next
                ? { "circuit.stops.$[nxt].status": CircuitStopStatus.ARRIVING }
                : {}),
            },
            $unset: { "circuit.exception": 1 },
            $inc: { stateVersion: 1 },
          },
          {
            returnDocument: "after",
            arrayFilters: [
              { "cur.order": order },
              ...(next ? [{ "nxt.order": order + 1 }] : []),
            ],
          },
        )
        .exec();
    }
    if (!updated)
      throw conflict(
        "The circuit changed while resolving. Reload and try again.",
        SYSTEM_STATE_CONFLICT,
      );

    await this.ledger.record({
      rideId: ride._id,
      type: "EXCEPTION_RESOLVED",
      actor,
      stopOrder: order,
      fromState: stop.status,
      toState:
        resolution === CircuitExceptionResolution.SKIP_STOP
          ? CircuitStopStatus.SKIPPED
          : stop.status,
      note,
      data: { resolution },
    });
    await this.audit.record({
      adminId,
      action: "circuit_ride.resolve_exception",
      targetType: "RIDE",
      targetId: ride._id.toString(),
      targetLabel: ride.rideCode,
      reason: note,
      metadata: { resolution, stopOrder: order, stop: stop.name },
    });
    if (resolution === CircuitExceptionResolution.SKIP_STOP) {
      this.events.circuitEvent(
        updated,
        CircuitEvent.STOP_SKIPPED,
        { stopOrder: order },
        {
          kind: "STOP_SKIPPED",
          stopName: stop.name,
          stopOrder: order,
          nextStopName: nextName,
        },
      );
    } else {
      this.events.circuitEvent(
        updated,
        CircuitEvent.EXCEPTION_RESOLVED,
        { stopOrder: order },
        { kind: "EXCEPTION_RESOLVED", stopName: stop.name, stopOrder: order },
      );
    }
    return updated;
  }

  /**
   * Support ends a circuit that cannot continue (customer unwell, vehicle
   * trouble). Unfinished stops are skipped and the circuit is billed for what it
   * used, exactly as if the driver had completed it.
   */
  async endEarly(
    adminId: string,
    rideId: string,
    reason: string,
  ): Promise<RideDocument> {
    const ride = await this.requireCircuit(rideId);
    if (ride.status === RideStatus.COMPLETED) return ride;
    this.assertRunning(ride, "end");
    const actor: RideActor = { type: RideActorType.ADMIN, userId: adminId };
    const circuit = ride.circuit!;
    const openStops = circuit.stops
      .filter(
        (stop) =>
          !(CIRCUIT_STOP_DONE as readonly string[]).includes(stop.status),
      )
      .map((stop) => stop.order);

    let current = ride;
    if (circuit.currentStopOrder <= circuit.stops.length) {
      const closed = await this.rideModel
        .findOneAndUpdate(
          {
            _id: ride._id,
            kind: RideKind.CIRCUIT,
            status: RideStatus.RIDE_STARTED,
            "circuit.currentStopOrder": { $lte: circuit.stops.length },
          },
          {
            $set: {
              "circuit.stops.$[open].status": CircuitStopStatus.SKIPPED,
              "circuit.stops.$[open].skippedAt": new Date(),
              "circuit.currentStopOrder": circuit.stops.length + 1,
              "circuit.endedEarlyReason": reason,
            },
            $unset: { "circuit.exception": 1 },
            $inc: { stateVersion: 1 },
          },
          {
            returnDocument: "after",
            arrayFilters: [{ "open.status": { $nin: [...CIRCUIT_STOP_DONE] } }],
          },
        )
        .exec();
      if (!closed)
        throw conflict(
          "The circuit changed while ending it. Reload and try again.",
          SYSTEM_STATE_CONFLICT,
        );
      current = closed;
    }
    await this.ledger.record({
      rideId: ride._id,
      type: "ENDED_EARLY",
      actor,
      note: reason,
      data: { skippedStops: openStops },
    });
    await this.audit.record({
      adminId,
      action: "circuit_ride.end_early",
      targetType: "RIDE",
      targetId: ride._id.toString(),
      targetLabel: ride.rideCode,
      reason,
      metadata: { skippedStops: openStops },
    });
    return this.finish(current, actor, "ADMIN");
  }

  // ── Internals ─────────────────────────────────────────────────────────

  private async stopCommand(
    driverUserId: string,
    rideId: string,
    order: number,
    command: StopCommand,
  ): Promise<DriverRideView> {
    const { driver, ride } = await this.loadForDriver(driverUserId, rideId);
    const { from, to } = STOP_COMMANDS[command];
    this.assertRunning(ride, `${command.toLowerCase()} a stop on`);
    const circuit = ride.circuit!;
    const stop = this.requireStop(ride, order);

    // Already there (a retry, or the first response was lost): same answer, no second change.
    if (
      stop.status !== CircuitStopStatus.SKIPPED &&
      STOP_RANK[stop.status] >= STOP_RANK[to]
    )
      return this.views.forDriver(ride, driver);
    if (circuit.exception)
      throw conflict(
        "Support is resolving an issue on this circuit",
        "CIRCUIT_EXCEPTION_OPEN",
      );
    if (order !== circuit.currentStopOrder)
      throw conflict(
        `Stop ${order} is not the current stop`,
        "CIRCUIT_STOP_INVALID",
        { currentStopOrder: circuit.currentStopOrder },
      );
    if (!(from as readonly CircuitStopStatus[]).includes(stop.status))
      throw conflict(
        `Stop ${order} is ${stop.status.toLowerCase()}`,
        "CIRCUIT_STOP_INVALID",
        { stopStatus: stop.status },
      );

    let locationVerified: boolean | undefined;
    if (command === "ARRIVE")
      locationVerified = await this.assertDriverNearStop(driver, stop);

    const now = new Date();
    const hasNext =
      command === "COMPLETE" &&
      circuit.stops.some((candidate) => candidate.order === order + 1);
    const guard = {
      _id: ride._id,
      driverId: driver._id,
      kind: RideKind.CIRCUIT,
      status: RideStatus.RIDE_STARTED,
      "circuit.currentStopOrder": order,
      "circuit.exception": { $exists: false },
      "circuit.stops": { $elemMatch: { order, status: { $in: [...from] } } },
    };
    const update =
      command === "COMPLETE"
        ? {
            $set: {
              "circuit.stops.$[cur].status": CircuitStopStatus.COMPLETED,
              "circuit.stops.$[cur].completedAt": now,
              "circuit.currentStopOrder": order + 1,
              ...(hasNext
                ? { "circuit.stops.$[nxt].status": CircuitStopStatus.ARRIVING }
                : {}),
            },
            $inc: { stateVersion: 1 },
          }
        : {
            $set: {
              "circuit.stops.$.status": to,
              [command === "ARRIVE"
                ? "circuit.stops.$.arrivedAt"
                : "circuit.stops.$.waitingAt"]: now,
            },
            $inc: { stateVersion: 1 },
          };
    const updated = await this.rideModel
      .findOneAndUpdate(guard, update, {
        returnDocument: "after",
        ...(command === "COMPLETE"
          ? {
              arrayFilters: [
                { "cur.order": order },
                ...(hasNext ? [{ "nxt.order": order + 1 }] : []),
              ],
            }
          : {}),
      })
      .exec();
    if (!updated) {
      // Lost a race (a retry landed first, or Admin intervened): answer from the truth.
      const latest = await this.rideModel
        .findOne({ _id: ride._id, driverId: driver._id })
        .exec();
      const latestStop = latest?.circuit?.stops.find(
        (candidate) => candidate.order === order,
      );
      if (
        latest &&
        latestStop &&
        latestStop.status !== CircuitStopStatus.SKIPPED &&
        STOP_RANK[latestStop.status] >= STOP_RANK[to]
      )
        return this.views.forDriver(latest, driver);
      throw await this.explainFailure(ride._id, driver);
    }

    await this.ledger.record({
      rideId: ride._id,
      type: `STOP_${to}`,
      actor: this.driverActor(driver),
      stopOrder: order,
      fromState: stop.status,
      toState: to,
      data: locationVerified === undefined ? undefined : { locationVerified },
    });
    const data = { stopOrder: order, stopName: stop.name };
    if (command === "ARRIVE")
      this.events.circuitEvent(updated, CircuitEvent.STOP_ARRIVED, data, {
        kind: "STOP_ARRIVED",
        stopName: stop.name,
        stopOrder: order,
      });
    else if (command === "WAIT")
      this.events.circuitEvent(updated, CircuitEvent.STOP_WAITING, data);
    else {
      this.events.circuitEvent(updated, CircuitEvent.STOP_COMPLETED, data);
      const next = updated.circuit?.stops.find(
        (candidate) => candidate.order === order + 1,
      );
      if (next)
        this.events.circuitEvent(
          updated,
          CircuitEvent.NEXT_STOP,
          { stopOrder: next.order, stopName: next.name },
          { kind: "NEXT_STOP", stopOrder: next.order, nextStopName: next.name },
        );
    }
    return this.views.forDriver(updated, driver);
  }

  /** The priced end of a circuit; shared by the driver's "complete" and Admin's "end early". */
  private async finish(
    ride: RideDocument,
    actor: RideActor,
    completedBy: "DRIVER" | "ADMIN",
  ): Promise<RideDocument> {
    const circuit = ride.circuit!;
    const completedAt = new Date();
    const driverId = ride.driverId!;
    const measurement = measureTrip(
      await this.locations.tripTrail(ride._id, driverId, ride.startedAt!),
      this.tripMeterMaxGapSeconds,
    );
    // The GPS trail when it can be trusted, else the booked route (a GPS fault must not produce a shock bill).
    const usedDistance = measurement.reliable
      ? measurement.distanceMeters
      : ride.distanceMeters;
    const usedDuration = Math.max(
      0,
      Math.round((completedAt.getTime() - ride.startedAt!.getTime()) / 1000),
    );
    const fare = calculateCircuitFare(
      circuit.pricing,
      usedDistance,
      usedDuration,
    );
    const distanceSource = measurement.reliable ? "ACTUAL" : "BOOKED";

    const snapshot: RideFinalFare = {
      distanceMeters: usedDistance,
      durationSeconds: usedDuration,
      distanceSource,
      durationSource: "ACTUAL",
      measuredDistanceMeters: measurement.distanceMeters,
      baseFare: fare.basePrice,
      distanceCharge: fare.extraDistanceCharge,
      timeCharge: fare.extraDurationCharge,
      subtotal: fare.subtotal,
      minimumFareApplied: false,
      capApplied: false,
      total: fare.total,
      discount: 0,
      payable: fare.total,
      pricingVersion: ride.fare.pricingVersion,
      mode: "package",
      computedAt: completedAt,
    };

    const completed = await this.transitions.apply({
      rideId: ride._id,
      from: RideStatus.RIDE_STARTED,
      to: RideStatus.COMPLETED,
      where: {
        kind: RideKind.CIRCUIT,
        driverId,
        "circuit.currentStopOrder": { $gt: circuit.stops.length },
        "circuit.exception": { $exists: false },
      },
      // Completing opens the bill; the ride is financially closed only when the payment is verified.
      set: {
        completedAt,
        "fare.finalFare": fare.total,
        "fare.final": snapshot,
        "circuit.usage.distanceMeters": usedDistance,
        "circuit.usage.reliable": measurement.reliable,
        "circuit.usage.measuredAt": completedAt,
        "circuit.settlement": {
          usedDistanceMeters: usedDistance,
          usedDurationSeconds: usedDuration,
          distanceSource,
          extraKm: fare.extraKm,
          extraBlocks: fare.extraBlocks,
          completedBy,
        },
        paymentStatus:
          fare.total > 0
            ? RidePaymentStatus.PENDING
            : RidePaymentStatus.NOT_REQUIRED,
      },
      actor,
      reason:
        completedBy === "ADMIN" ? "CIRCUIT_ENDED_EARLY" : "CIRCUIT_COMPLETED",
      metadata: {
        finalFare: fare.total,
        packagePrice: fare.basePrice,
        extraKm: fare.extraKm,
        extraDistanceCharge: fare.extraDistanceCharge,
        extraBlocks: fare.extraBlocks,
        extraDurationCharge: fare.extraDurationCharge,
        distanceMeters: usedDistance,
        distanceSource,
        durationSeconds: usedDuration,
        trail: {
          points: measurement.points,
          reliable: measurement.reliable,
          reason: measurement.reason,
        },
      },
    });
    if (!completed) {
      const latest = await this.rideModel.findById(ride._id).exec();
      if (latest?.status === RideStatus.COMPLETED) return latest;
      throw await this.explainFailure(ride._id, undefined);
    }

    await this.matching.release(driverId, completed._id, {
      completedRide: true,
    });
    void this.locations.recordCheckpoint(
      completed._id,
      driverId,
      CheckpointKind.COMPLETED,
    );
    await this.ledger.record({
      rideId: completed._id,
      type: completedBy === "ADMIN" ? "COMPLETED_BY_ADMIN" : "COMPLETED",
      actor,
      data: {
        finalFare: fare.total,
        extraKm: fare.extraKm,
        extraBlocks: fare.extraBlocks,
        usedDistance,
        usedDuration,
        distanceSource,
      },
    });
    this.events.circuitEvent(completed, CircuitEvent.COMPLETED, {
      finalFare: fare.total,
      completedBy,
    });
    this.dispatch.kick();
    return completed;
  }

  /** True when a fresh fix put the driver near the stop; undefined when there was no usable fix (GPS loss must not strand a circuit). */
  private async assertDriverNearStop(
    driver: DriverProfileDocument,
    stop: { latitude: number; longitude: number; name: string },
  ): Promise<boolean | undefined> {
    if (this.arrivalRadiusMeters <= 0) return undefined;
    const last = await this.locations.lastKnown(driver._id);
    if (
      !last ||
      Date.now() - last.updatedAt.getTime() > this.locations.freshnessWindowMs
    )
      return undefined;
    const distance = Math.round(haversineMeters(last, stop));
    if (distance > this.arrivalRadiusMeters)
      throw conflict(
        `You are about ${distance} m from ${stop.name}. Drive closer to mark arrival.`,
        "CIRCUIT_NOT_AT_STOP",
        {
          distanceMeters: distance,
          radiusMeters: this.arrivalRadiusMeters,
        },
      );
    return true;
  }

  private async loadForDriver(
    driverUserId: string,
    rideId: string,
  ): Promise<{ driver: DriverProfileDocument; ride: RideDocument }> {
    const driver = await this.rides.resolveDriver(driverUserId);
    await this.matching.touch(driver._id);
    const ride = Types.ObjectId.isValid(rideId)
      ? await this.rideModel
          .findOne({
            _id: rideId,
            driverId: driver._id,
            kind: RideKind.CIRCUIT,
          })
          .exec()
      : null;
    if (!ride?.circuit)
      throw apiNotFound("Circuit not found", "CIRCUIT_NOT_FOUND");
    return { driver, ride };
  }

  private async requireCircuit(rideId: string): Promise<RideDocument> {
    const ride = Types.ObjectId.isValid(rideId)
      ? await this.rideModel
          .findOne({ _id: rideId, kind: RideKind.CIRCUIT })
          .exec()
      : null;
    if (!ride?.circuit)
      throw apiNotFound("Circuit not found", "CIRCUIT_NOT_FOUND");
    return ride;
  }

  private assertRunning(ride: RideDocument, action: string): void {
    if (ride.status !== RideStatus.RIDE_STARTED)
      throw conflict(
        `Cannot ${action} a circuit that is ${ride.status.toLowerCase().replace(/_/g, " ")}`,
        "CIRCUIT_NOT_STARTED",
        {
          currentStatus: ride.status,
        },
      );
  }

  private requireStop(ride: RideDocument, order: number) {
    const stop = ride.circuit?.stops.find(
      (candidate) => candidate.order === order,
    );
    if (!stop)
      throw apiBadRequest(
        `This circuit has no stop ${order}`,
        "CIRCUIT_STOP_INVALID",
      );
    return stop;
  }

  private driverActor(driver: DriverProfileDocument): RideActor {
    return { type: RideActorType.DRIVER, userId: driver.userId };
  }

  /** A guarded update missed: say why, from the ride as it is now. */
  private async explainFailure(
    rideId: Types.ObjectId,
    driver: DriverProfileDocument | undefined,
  ): Promise<ApiException> {
    const ride = await this.rideModel
      .findOne({ _id: rideId, ...(driver ? { driverId: driver._id } : {}) })
      .exec();
    if (!ride)
      return new ApiException(
        HttpStatus.NOT_FOUND,
        "Circuit not found",
        "CIRCUIT_NOT_FOUND",
      );
    if (ride.status !== RideStatus.RIDE_STARTED)
      return conflict(
        `The circuit is ${ride.status.toLowerCase().replace(/_/g, " ")}`,
        "CIRCUIT_NOT_STARTED",
        { currentStatus: ride.status },
      );
    if (ride.circuit?.exception)
      return conflict(
        "Support is resolving an issue on this circuit",
        "CIRCUIT_EXCEPTION_OPEN",
      );
    return conflict(
      "The circuit changed. Please refresh.",
      SYSTEM_STATE_CONFLICT,
      { currentStopOrder: ride.circuit?.currentStopOrder },
    );
  }
}
