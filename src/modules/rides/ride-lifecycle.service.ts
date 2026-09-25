import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectModel } from "@nestjs/mongoose";
import type { Model, QueryFilter } from "mongoose";
import { Types } from "mongoose";
import { ApiException } from "../../common/exceptions/api.exception";
import { UserRole } from "../../common/types/user-role.enum";
import type { AuthenticatedUser } from "../../common/types/jwt-payload";
import type { DriverProfileDocument } from "../drivers/schemas/driver-profile.schema";
import { DriverLocationService } from "../locations/driver-location.service";
import { CheckpointKind } from "../locations/schemas/driver-location-checkpoint.schema";
import { MatchingService } from "../matching/matching.service";
import { calculateFare } from "../pricing/fare-calculator";
import { RideDispatchService } from "./ride-dispatch.service";
import { rideConflict, rideNotFound } from "./ride-errors";
import { RideEventsService } from "./ride-events.service";
import { generateRideOtp, rideOtpMatches } from "./ride-otp";
import { RidePaymentStatus } from "./ride-payment-status";
import {
  CUSTOMER_CANCELLABLE_STATUSES,
  DRIVER_CANCELLABLE_STATUSES,
  RideActorType,
  RideStatus,
} from "./ride-state-machine";
import { RideTransitionService } from "./ride-transition.service";
import type { RideActor } from "./ride-transition.service";
import { RideViewService } from "./ride-view.service";
import type { CustomerRideView, DriverRideView } from "./ride-view.service";
import { RidesService } from "./rides.service";
import { Ride } from "./schemas/ride.schema";

const MAX_CANCEL_RETRIES = 3;

/**
 * Driver actions (accept → arrived → start → complete, or reject) and
 * cancellation. Each action is a guarded transition; when the guard fails the
 * ride is re-read only to explain *why* with the right 404/409.
 */
@Injectable()
export class RideLifecycleService {
  private readonly logger = new Logger(RideLifecycleService.name);
  private readonly otpTtlMs: number;
  private readonly otpMaxAttempts: number;

  constructor(
    @InjectModel(Ride.name) private readonly rideModel: Model<Ride>,
    private readonly rides: RidesService,
    private readonly dispatch: RideDispatchService,
    private readonly matching: MatchingService,
    private readonly transitions: RideTransitionService,
    private readonly views: RideViewService,
    private readonly locations: DriverLocationService,
    private readonly events: RideEventsService,
    config: ConfigService,
  ) {
    this.otpTtlMs = config.getOrThrow<number>("rideOtpTtlMinutes") * 60_000;
    this.otpMaxAttempts = config.getOrThrow<number>("rideOtpMaxAttempts");
  }

  // ── Driver actions ────────────────────────────────────────────────────

  async accept(driverUserId: string, rideId: string): Promise<DriverRideView> {
    const driver = await this.driverFor(driverUserId);
    if (!driver.isOnline)
      throw new ApiException(HttpStatus.CONFLICT, "Go online to accept rides", "DRIVER_OFFLINE");

    const id = new Types.ObjectId(rideId);
    const accepted = await this.transitions.apply({
      rideId: id,
      from: RideStatus.DRIVER_ASSIGNED,
      to: RideStatus.DRIVER_ACCEPTED,
      // Ownership + freshness in the same atomic guard: only the assigned
      // driver, and only before the offer lapsed.
      where: { driverId: driver._id, assignmentExpiresAt: { $gt: new Date() } },
      set: { acceptedAt: new Date() },
      unset: ["assignmentExpiresAt"],
      actor: this.actorFor(driverUserId, RideActorType.DRIVER),
    });
    if (accepted) {
      void this.locations.recordCheckpoint(accepted._id, driver._id, CheckpointKind.ACCEPTED);
      return this.views.forDriver(accepted, driver);
    }
    throw await this.explainOfferFailure(id, driver, "accept");
  }

  async reject(driverUserId: string, rideId: string, reason?: string): Promise<{ rejected: true }> {
    const driver = await this.driverFor(driverUserId);
    const id = new Types.ObjectId(rideId);
    const result = await this.dispatch.endAssignment(
      id,
      driver._id,
      "DRIVER_REJECTED",
      this.actorFor(driverUserId, RideActorType.DRIVER),
      reason,
    );
    if (result) {
      // The driver is free again: offer them anything else that is waiting.
      this.dispatch.kick();
      return { rejected: true };
    }
    throw await this.explainOfferFailure(id, driver, "reject");
  }

  async arrived(driverUserId: string, rideId: string): Promise<DriverRideView> {
    const driver = await this.driverFor(driverUserId);
    const now = new Date();
    const ride = await this.transitions.apply({
      rideId: new Types.ObjectId(rideId),
      from: RideStatus.DRIVER_ACCEPTED,
      to: RideStatus.DRIVER_ARRIVED,
      where: { driverId: driver._id },
      // The start-of-trip OTP is minted here, when the customer needs it.
      set: {
        arrivedAt: now,
        otpCode: generateRideOtp(),
        otpExpiresAt: new Date(now.getTime() + this.otpTtlMs),
        otpAttempts: 0,
      },
      actor: this.actorFor(driverUserId, RideActorType.DRIVER),
    });
    if (ride) {
      void this.locations.recordCheckpoint(ride._id, driver._id, CheckpointKind.ARRIVED);
      return this.views.forDriver(ride, driver);
    }
    throw await this.explainDriverActionFailure(rideId, driver, "mark arrived for");
  }

  /**
   * Starting requires the customer's OTP. Wrong codes are counted; on
   * lockout or expiry the code is rotated so a stolen/guessed code is
   * useless; the customer's app receives the new one as `ride.otp_refreshed`.
   */
  async start(driverUserId: string, rideId: string, otp: string): Promise<DriverRideView> {
    const driver = await this.driverFor(driverUserId);
    const ride = await this.rideModel
      .findOne({ _id: rideId, driverId: driver._id })
      .select("+otpCode")
      .exec();
    if (!ride) throw rideNotFound();
    if (ride.status !== RideStatus.DRIVER_ARRIVED)
      throw rideConflict(this.wrongStateMessage("start", ride.status), ride.status);
    const expectedCode = ride.otpCode;

    if (!expectedCode || !ride.otpExpiresAt || ride.otpExpiresAt.getTime() <= Date.now()) {
      await this.rotateOtp(ride._id, "OTP_EXPIRED");
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        "This OTP has expired. Ask the customer for the new code in their app.",
        "RIDE_OTP_EXPIRED",
      );
    }

    if (!rideOtpMatches(otp, expectedCode)) {
      const counted = await this.rideModel
        .findOneAndUpdate(
          { _id: ride._id, status: RideStatus.DRIVER_ARRIVED, otpCode: expectedCode },
          { $inc: { otpAttempts: 1 } },
          { returnDocument: "after" },
        )
        .exec();
      const attempts = counted?.otpAttempts ?? this.otpMaxAttempts;
      if (attempts >= this.otpMaxAttempts) {
        await this.rotateOtp(ride._id, "OTP_LOCKED");
        throw new ApiException(
          HttpStatus.BAD_REQUEST,
          "Too many incorrect attempts. Ask the customer for the new code in their app.",
          "RIDE_OTP_TOO_MANY_ATTEMPTS",
        );
      }
      throw new ApiException(HttpStatus.BAD_REQUEST, "Incorrect OTP", "RIDE_OTP_INVALID", {
        attemptsRemaining: this.otpMaxAttempts - attempts,
      });
    }

    const started = await this.transitions.apply({
      rideId: ride._id,
      from: RideStatus.DRIVER_ARRIVED,
      to: RideStatus.RIDE_STARTED,
      // Guarded on the exact code verified, so a concurrent rotation or a
      // second verify of the same code cannot also start the ride.
      where: { driverId: driver._id, otpCode: expectedCode },
      set: { startedAt: new Date(), otpVerifiedAt: new Date() },
      unset: ["otpCode", "otpExpiresAt"],
      actor: this.actorFor(driverUserId, RideActorType.DRIVER),
      metadata: { otpVerified: true },
    });
    if (started) {
      void this.locations.recordCheckpoint(started._id, driver._id, CheckpointKind.STARTED);
      return this.views.forDriver(started, driver);
    }
    throw await this.explainDriverActionFailure(rideId, driver, "start");
  }

  async complete(driverUserId: string, rideId: string): Promise<DriverRideView> {
    const driver = await this.driverFor(driverUserId);
    const ride = await this.rideModel.findOne({ _id: rideId, driverId: driver._id }).exec();
    if (!ride) throw rideNotFound();
    if (ride.status !== RideStatus.RIDE_STARTED)
      throw rideConflict(this.wrongStateMessage("complete", ride.status), ride.status);

    // Priced with the tariff snapshotted at booking, never today's tariff.
    // Phase 2 has no trip tracking, so the booked distance/duration stand in
    // for actuals; Phase 3 feeds real telemetry into the same calculation.
    const finalFare = calculateFare(ride.fare, ride.distanceMeters, ride.durationSeconds).total;

    const completed = await this.transitions.apply({
      rideId: ride._id,
      from: RideStatus.RIDE_STARTED,
      to: RideStatus.COMPLETED,
      where: { driverId: driver._id },
      // Completing the trip opens the bill; it does not close it. The ride is
      // financially closed only when the payment is verified (Phase 4).
      set: {
        completedAt: new Date(),
        "fare.finalFare": finalFare,
        paymentStatus: finalFare > 0 ? RidePaymentStatus.PENDING : RidePaymentStatus.NOT_REQUIRED,
      },
      actor: this.actorFor(driverUserId, RideActorType.DRIVER),
      metadata: { finalFare },
    });
    if (!completed) throw await this.explainDriverActionFailure(rideId, driver, "complete");

    await this.matching.release(driver._id, completed._id, { completedRide: true });
    void this.locations.recordCheckpoint(completed._id, driver._id, CheckpointKind.COMPLETED);
    this.dispatch.kick();
    return this.views.forDriver(completed, driver);
  }

  // ── Cancellation ──────────────────────────────────────────────────────

  async cancel(
    user: AuthenticatedUser,
    rideId: string,
    reason?: string,
  ): Promise<CustomerRideView | DriverRideView> {
    const isDriver = user.role === UserRole.DRIVER;
    const driver = isDriver ? await this.driverFor(user.userId) : undefined;
    const owner: QueryFilter<Ride> = driver
      ? { driverId: driver._id }
      : { customerId: new Types.ObjectId(user.userId) };
    const cancellable = isDriver ? DRIVER_CANCELLABLE_STATUSES : CUSTOMER_CANCELLABLE_STATUSES;
    const actor = this.actorFor(user.userId, isDriver ? RideActorType.DRIVER : RideActorType.CUSTOMER);

    // Optimistic loop: the status can move under us (driver accepts while the
    // customer taps cancel). Re-read and re-check rather than guess.
    for (let attempt = 0; attempt < MAX_CANCEL_RETRIES; attempt += 1) {
      const ride = await this.rideModel.findOne({ ...owner, _id: rideId }).exec();
      if (!ride) throw rideNotFound();
      if (!cancellable.includes(ride.status))
        throw rideConflict(
          isDriver && ride.status === RideStatus.DRIVER_ASSIGNED
            ? "Reject the request instead of cancelling it"
            : `A ride that is ${this.describe(ride.status)} cannot be cancelled`,
          ride.status,
          "RIDE_NOT_CANCELLABLE",
        );

      const cancelled = await this.transitions.apply({
        rideId: ride._id,
        from: ride.status,
        to: RideStatus.CANCELLED,
        where: owner,
        set: {
          cancelledAt: new Date(),
          cancellation: { cancelledBy: actor.type, cancelledByUserId: actor.userId, reason },
        },
        unset: ["otpCode", "otpExpiresAt", "assignmentExpiresAt"],
        actor,
        reason,
      });
      if (!cancelled) continue;

      if (ride.driverId) {
        await this.matching.release(ride.driverId, ride._id);
        if (ride.acceptedAt)
          void this.locations.recordCheckpoint(ride._id, ride.driverId, CheckpointKind.CANCELLED);
        this.dispatch.kick();
      }
      return driver ? this.views.forDriver(cancelled, driver) : this.views.forCustomer(cancelled);
    }
    const latest = await this.rideModel.findOne({ ...owner, _id: rideId }).exec();
    throw rideConflict(
      "The ride changed while cancelling. Please try again.",
      latest?.status ?? RideStatus.CANCELLED,
      "RIDE_STATE_CONFLICT",
    );
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  private async driverFor(driverUserId: string): Promise<DriverProfileDocument> {
    const driver = await this.rides.resolveDriver(driverUserId);
    await this.matching.touch(driver._id);
    return driver;
  }

  private actorFor(userId: string, type: RideActorType): RideActor {
    return { type, userId: new Types.ObjectId(userId) };
  }

  private async rotateOtp(rideId: Types.ObjectId, reason: string): Promise<void> {
    const rotated = await this.rideModel
      .updateOne(
        { _id: rideId, status: RideStatus.DRIVER_ARRIVED },
        {
          $set: {
            otpCode: generateRideOtp(),
            otpExpiresAt: new Date(Date.now() + this.otpTtlMs),
            otpAttempts: 0,
          },
          $inc: { stateVersion: 1 },
        },
      )
      .exec();
    // The customer's app shows the new code immediately — no poll needed.
    if (rotated.modifiedCount === 1) this.events.otpRefreshed(rideId);
    this.logger.warn(`Rotated OTP for ride ${rideId.toString()} (${reason})`);
  }

  /**
   * Accept/reject failed its guard. Distinguish "not yours" (404), "someone
   * else has it / it moved on" (409), and "your offer lapsed" (409, after
   * applying the timeout so the ride is re-matched right away).
   */
  private async explainOfferFailure(
    rideId: Types.ObjectId,
    driver: DriverProfileDocument,
    action: "accept" | "reject",
  ): Promise<ApiException | ReturnType<typeof rideNotFound>> {
    const ride = await this.rideModel.findById(rideId).exec();
    if (!ride) return rideNotFound();

    const assignedToMe = ride.driverId?.equals(driver._id) ?? false;
    const wasOfferedToMe = assignedToMe || ride.rejectedDriverIds.some((id) => id.equals(driver._id));
    if (!wasOfferedToMe)
      // A driver who was never offered the ride learns nothing about it —
      // except the classic race loser, who gets the conflict the spec wants.
      return ride.status === RideStatus.DRIVER_ASSIGNED || ride.status === RideStatus.DRIVER_ACCEPTED
        ? rideConflict("This ride is no longer available", ride.status, "RIDE_STATE_CONFLICT")
        : rideNotFound();

    if (!assignedToMe)
      return rideConflict("This request is no longer assigned to you", ride.status, "RIDE_STATE_CONFLICT");

    if (ride.status === RideStatus.DRIVER_ASSIGNED) {
      // Offer lapsed between the driver's last poll and the tap.
      await this.dispatch.settle(ride);
      return rideConflict("This request has expired", RideStatus.SEARCHING, "RIDE_STATE_CONFLICT");
    }
    return rideConflict(
      ride.status === RideStatus.DRIVER_ACCEPTED && action === "accept"
        ? "You have already accepted this ride"
        : this.wrongStateMessage(action, ride.status),
      ride.status,
    );
  }

  private async explainDriverActionFailure(
    rideId: string,
    driver: DriverProfileDocument,
    action: string,
  ): Promise<ApiException | ReturnType<typeof rideNotFound>> {
    const ride = await this.rideModel.findOne({ _id: rideId, driverId: driver._id }).exec();
    if (!ride) return rideNotFound();
    return rideConflict(this.wrongStateMessage(action, ride.status), ride.status);
  }

  private wrongStateMessage(action: string, status: RideStatus): string {
    return `Cannot ${action} a ride that is ${this.describe(status)}`;
  }

  private describe(status: RideStatus): string {
    return status.toLowerCase().replace(/_/g, " ");
  }
}
