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
import type { FinalFareMode } from "../../config/environment";
import { measureTrip, resolveFinalFare } from "../pricing/trip-meter";
import { CancellationsService } from "../cancellations/cancellations.service";
import type {
  CancellationPreview,
  ResolvedReason,
} from "../cancellations/cancellations.service";
import { CancellationFeeStatus } from "../cancellations/schemas/cancellation.schemas";
import { computeDiscount } from "../promotions/promo-rules";
import {
  CircuitEvent,
  CircuitStopStatus,
  RideKind,
} from "../circuit-rides/circuit-ride.types";
import { RideEvent } from "../realtime/realtime.constants";
import { SosEvent } from "../safety/schemas/sos-event.schema";
import {
  RideCompletionMode,
  evaluateEndLocation,
  overrideAvailableAt,
} from "./ride-completion";
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
import type { RideDocument, RideFinalFare } from "./schemas/ride.schema";

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
  private readonly endOtpEnforced: boolean;
  private readonly endOverrideWaitSeconds: number;
  private readonly endFarRadiusMeters: number;
  private readonly finalFareMode: FinalFareMode;
  private readonly finalFareMaxEstimateMultiplier: number;
  private readonly tripMeterMaxGapSeconds: number;

  constructor(
    @InjectModel(Ride.name) private readonly rideModel: Model<Ride>,
    @InjectModel(SosEvent.name) private readonly sosModel: Model<SosEvent>,
    private readonly rides: RidesService,
    private readonly dispatch: RideDispatchService,
    private readonly matching: MatchingService,
    private readonly transitions: RideTransitionService,
    private readonly views: RideViewService,
    private readonly locations: DriverLocationService,
    private readonly events: RideEventsService,
    private readonly cancellations: CancellationsService,
    config: ConfigService,
  ) {
    this.otpTtlMs = config.getOrThrow<number>("rideOtpTtlMinutes") * 60_000;
    this.otpMaxAttempts = config.getOrThrow<number>("rideOtpMaxAttempts");
    this.endOtpEnforced = config.getOrThrow<boolean>("rideEndOtpEnforced");
    this.endOverrideWaitSeconds = config.getOrThrow<number>(
      "rideEndOverrideWaitSeconds",
    );
    this.endFarRadiusMeters = config.getOrThrow<number>(
      "rideEndFarRadiusMeters",
    );
    this.finalFareMode = config.getOrThrow<FinalFareMode>("finalFareMode");
    this.finalFareMaxEstimateMultiplier = config.getOrThrow<number>(
      "finalFareMaxEstimateMultiplier",
    );
    this.tripMeterMaxGapSeconds = config.getOrThrow<number>(
      "tripMeterMaxGapSeconds",
    );
  }

  // ── Driver actions ────────────────────────────────────────────────────

  async accept(driverUserId: string, rideId: string): Promise<DriverRideView> {
    const driver = await this.driverFor(driverUserId);
    if (!driver.isOnline)
      throw new ApiException(
        HttpStatus.CONFLICT,
        "Go online to accept rides",
        "DRIVER_OFFLINE",
      );

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
      void this.locations.recordCheckpoint(
        accepted._id,
        driver._id,
        CheckpointKind.ACCEPTED,
      );
      return this.views.forDriver(accepted, driver);
    }
    throw await this.explainOfferFailure(id, driver, "accept");
  }

  async reject(
    driverUserId: string,
    rideId: string,
    reason?: string,
  ): Promise<{ rejected: true }> {
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
      void this.locations.recordCheckpoint(
        ride._id,
        driver._id,
        CheckpointKind.ARRIVED,
      );
      return this.views.forDriver(ride, driver);
    }
    throw await this.explainDriverActionFailure(
      rideId,
      driver,
      "mark arrived for",
    );
  }

  /**
   * Starting requires the customer's OTP. Wrong codes are counted; on
   * lockout or expiry the code is rotated so a stolen/guessed code is
   * useless; the customer's app receives the new one as `ride.otp_refreshed`.
   */
  async start(
    driverUserId: string,
    rideId: string,
    otp: string,
  ): Promise<DriverRideView> {
    const driver = await this.driverFor(driverUserId);
    const ride = await this.rideModel
      .findOne({ _id: rideId, driverId: driver._id })
      .select("+otpCode")
      .exec();
    if (!ride) throw rideNotFound();
    if (ride.status !== RideStatus.DRIVER_ARRIVED)
      throw rideConflict(
        this.wrongStateMessage("start", ride.status),
        ride.status,
      );
    const expectedCode = ride.otpCode;

    if (
      !expectedCode ||
      !ride.otpExpiresAt ||
      ride.otpExpiresAt.getTime() <= Date.now()
    ) {
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
          {
            _id: ride._id,
            status: RideStatus.DRIVER_ARRIVED,
            otpCode: expectedCode,
          },
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
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        "Incorrect OTP",
        "RIDE_OTP_INVALID",
        {
          attemptsRemaining: this.otpMaxAttempts - attempts,
        },
      );
    }

    const started = await this.transitions.apply({
      rideId: ride._id,
      from: RideStatus.DRIVER_ARRIVED,
      to: RideStatus.RIDE_STARTED,
      // Guarded on the exact code verified, so a concurrent rotation or a
      // second verify of the same code cannot also start the ride.
      where: { driverId: driver._id, otpCode: expectedCode },
      set: {
        startedAt: new Date(),
        otpVerifiedAt: new Date(),
        // The circuit clock is startedAt; the first stop becomes the one being driven to.
        ...(ride.kind === RideKind.CIRCUIT
          ? {
              "circuit.currentStopOrder": 1,
              "circuit.stops.0.status": CircuitStopStatus.ARRIVING,
            }
          : {}),
      },
      unset: ["otpCode", "otpExpiresAt"],
      actor: this.actorFor(driverUserId, RideActorType.DRIVER),
      metadata: { otpVerified: true },
    });
    if (started) {
      void this.locations.recordCheckpoint(
        started._id,
        driver._id,
        CheckpointKind.STARTED,
      );
      if (started.kind === RideKind.CIRCUIT)
        this.events.circuitEvent(started, CircuitEvent.STARTED);
      return this.views.forDriver(started, driver);
    }
    throw await this.explainDriverActionFailure(rideId, driver, "start");
  }

  /**
   * The driver asks to end the trip. The ride stays RIDE_STARTED; what changes
   * is that the rider's app now shows the end-of-trip OTP (and is pushed a
   * notice), and the fare is frozen to this moment so the time spent waiting
   * for the code is not charged. Asking again while the code is valid returns
   * the same state; after it expired a fresh code is minted but the original
   * moment stays. Where the driver is relative to the booked drop-off is
   * recorded here and flagged when far.
   */
  async requestEnd(
    driverUserId: string,
    rideId: string,
  ): Promise<DriverRideView> {
    const driver = await this.driverFor(driverUserId);
    const ride = await this.rideModel
      .findOne({ _id: rideId, driverId: driver._id })
      .select("+endOtpCode")
      .exec();
    if (!ride) throw rideNotFound();
    this.assertEndable(ride, "end");

    const now = new Date();
    if (
      ride.endRequestedAt &&
      ride.endOtpCode &&
      ride.endOtpExpiresAt &&
      ride.endOtpExpiresAt.getTime() > now.getTime()
    )
      return this.views.forDriver(ride, driver);

    const first = !ride.endRequestedAt;
    const check = first
      ? evaluateEndLocation({
          location: await this.locations.lastKnown(driver._id),
          destination: ride.destination,
          farRadiusMeters: this.endFarRadiusMeters,
        })
      : undefined;
    const updated = await this.rideModel
      .findOneAndUpdate(
        {
          _id: ride._id,
          driverId: driver._id,
          status: RideStatus.RIDE_STARTED,
          // Compare-and-set: two taps cannot both be "the first request".
          endRequestedAt: ride.endRequestedAt ?? { $exists: false },
        },
        {
          $set: {
            endRequestedAt: ride.endRequestedAt ?? now,
            endOtpCode: generateRideOtp(),
            endOtpExpiresAt: new Date(now.getTime() + this.otpTtlMs),
            endOtpAttempts: 0,
            ...(check ? { endCheck: check } : {}),
          },
          $inc: { stateVersion: 1 },
        },
        { returnDocument: "after" },
      )
      .exec();
    if (!updated) {
      // Lost a race with the same request (a double tap): report its result.
      const latest = await this.rideModel
        .findOne({ _id: rideId, driverId: driver._id })
        .exec();
      if (
        latest?.status === RideStatus.RIDE_STARTED &&
        latest.endRequestedAt
      )
        return this.views.forDriver(latest, driver);
      throw await this.explainDriverActionFailure(rideId, driver, "end");
    }

    // The drop-off position, so the trip meter measures up to where it ended.
    if (first)
      void this.locations.recordCheckpoint(
        updated._id,
        driver._id,
        CheckpointKind.TRIP,
      );
    this.events.endOtpChanged(updated, RideEvent.END_REQUESTED);
    return this.views.forDriver(updated, driver);
  }

  /** The driver took the end request back (a mis-tap, or the rider asked to go further). */
  async cancelEnd(
    driverUserId: string,
    rideId: string,
  ): Promise<DriverRideView> {
    const driver = await this.driverFor(driverUserId);
    const ride = await this.rideModel
      .findOne({ _id: rideId, driverId: driver._id })
      .exec();
    if (!ride) throw rideNotFound();
    this.assertEndable(ride, "continue");
    if (!ride.endRequestedAt) return this.views.forDriver(ride, driver);

    const updated = await this.rideModel
      .findOneAndUpdate(
        {
          _id: ride._id,
          driverId: driver._id,
          status: RideStatus.RIDE_STARTED,
          endRequestedAt: { $exists: true },
        },
        {
          $unset: {
            endRequestedAt: 1,
            endOtpCode: 1,
            endOtpExpiresAt: 1,
            endCheck: 1,
          },
          $set: { endOtpAttempts: 0 },
          $inc: { stateVersion: 1 },
        },
        { returnDocument: "after" },
      )
      .exec();
    if (!updated)
      throw await this.explainDriverActionFailure(rideId, driver, "continue");
    this.events.endOtpChanged(updated, RideEvent.END_CANCELLED);
    return this.views.forDriver(updated, driver);
  }

  /**
   * Completes the trip with the rider's end-of-trip OTP. With an SOS open on
   * the ride no code is asked for (nobody should have to negotiate for one
   * during an emergency). RIDE_END_OTP_ENFORCED=false lets an older app that
   * never asks for a code complete as before.
   */
  async complete(
    driverUserId: string,
    rideId: string,
    otp?: string,
  ): Promise<DriverRideView> {
    const driver = await this.driverFor(driverUserId);
    const ride = await this.rideModel
      .findOne({ _id: rideId, driverId: driver._id })
      .select("+endOtpCode")
      .exec();
    if (!ride) throw rideNotFound();
    this.assertEndable(ride, "complete");

    let mode: RideCompletionMode;
    let verifiedCode: string | undefined;
    if (otp !== undefined && ride.endRequestedAt) {
      verifiedCode = await this.verifyEndOtp(ride, otp);
      mode = RideCompletionMode.OTP;
    } else if (await this.sosOpen(ride._id)) {
      mode = RideCompletionMode.SOS;
    } else if (!this.endOtpEnforced) {
      mode = RideCompletionMode.NOT_REQUIRED;
    } else {
      throw new ApiException(
        HttpStatus.CONFLICT,
        ride.endRequestedAt
          ? "Enter the end-of-trip code the rider sees in their app"
          : "Ask the rider for the end-of-trip code first",
        "RIDE_END_OTP_REQUIRED",
        {
          currentStatus: ride.status,
          endRequested: Boolean(ride.endRequestedAt),
        },
      );
    }

    return this.finishAsDriver(ride, driver, driverUserId, {
      mode,
      expectedCode: verifiedCode,
    });
  }

  /**
   * "Rider not responding": the rider cannot or will not give the code. Only
   * after the driver asked to end the trip and waited RIDE_END_OVERRIDE_WAIT_SECONDS
   * (immediately while an SOS is open). The trip is completed, marked
   * DRIVER_OVERRIDE with the driver's reason and left for the ops team to review.
   */
  async completeWithoutOtp(
    driverUserId: string,
    rideId: string,
    reason: string,
  ): Promise<DriverRideView> {
    const driver = await this.driverFor(driverUserId);
    const ride = await this.rideModel
      .findOne({ _id: rideId, driverId: driver._id })
      .exec();
    if (!ride) throw rideNotFound();
    this.assertEndable(ride, "complete");
    if (!ride.endRequestedAt)
      throw new ApiException(
        HttpStatus.CONFLICT,
        "Ask the rider for the end-of-trip code first",
        "RIDE_END_NOT_REQUESTED",
        { currentStatus: ride.status },
      );

    const sosOpen = await this.sosOpen(ride._id);
    if (!sosOpen) {
      const availableAt = overrideAvailableAt(
        ride.endRequestedAt,
        this.endOverrideWaitSeconds,
      );
      const waitMs = availableAt.getTime() - Date.now();
      if (waitMs > 0)
        throw new ApiException(
          HttpStatus.CONFLICT,
          "Please wait a little longer for the rider before ending without a code",
          "RIDE_END_OVERRIDE_TOO_EARLY",
          {
            currentStatus: ride.status,
            availableAt: availableAt.toISOString(),
            retryAfterSeconds: Math.ceil(waitMs / 1000),
          },
        );
    }
    return this.finishAsDriver(ride, driver, driverUserId, {
      mode: sosOpen
        ? RideCompletionMode.SOS
        : RideCompletionMode.DRIVER_OVERRIDE,
      note: reason,
    });
  }

  /**
   * Ops completes a trip that is stuck (rider unreachable, driver's app
   * down). Priced like any other end; recorded as ADMIN with the note.
   */
  async completeAsAdmin(
    adminUserId: string,
    rideId: string,
    note: string,
  ): Promise<void> {
    const ride = await this.rideModel.findById(rideId).exec();
    if (!ride) throw rideNotFound();
    this.assertEndable(ride, "complete");
    if (!ride.driverId)
      throw rideConflict(
        "This ride has no driver to complete it",
        ride.status,
        "RIDE_STATE_CONFLICT",
      );
    const completed = await this.finish(ride, {
      mode: RideCompletionMode.ADMIN,
      note,
      actor: this.actorFor(adminUserId, RideActorType.ADMIN),
    });
    if (!completed)
      throw rideConflict(
        "The ride changed while completing it. Reload and retry.",
        ride.status,
        "RIDE_STATE_CONFLICT",
      );
  }

  /** Only a normal (non-circuit) trip that is under way can be ended. */
  private assertEndable(ride: RideDocument, action: string): void {
    if (ride.status !== RideStatus.RIDE_STARTED)
      throw rideConflict(this.wrongStateMessage(action, ride.status), ride.status);
    // A circuit ends only when its stops are done, priced by its package: POST /circuit-rides/:id/complete.
    if (ride.kind === RideKind.CIRCUIT)
      throw rideConflict(
        "Finish the circuit from its own screen",
        ride.status,
        "CIRCUIT_COMPLETE_REQUIRED",
      );
  }

  private async sosOpen(rideId: Types.ObjectId): Promise<boolean> {
    return Boolean(await this.sosModel.exists({ rideId, isOpen: true }));
  }

  private async finishAsDriver(
    ride: RideDocument,
    driver: DriverProfileDocument,
    driverUserId: string,
    options: {
      mode: RideCompletionMode;
      note?: string;
      expectedCode?: string;
    },
  ): Promise<DriverRideView> {
    const completed = await this.finish(ride, {
      ...options,
      actor: this.actorFor(driverUserId, RideActorType.DRIVER),
    });
    if (!completed)
      throw await this.explainDriverActionFailure(
        ride._id.toString(),
        driver,
        "complete",
      );
    return this.views.forDriver(completed, driver);
  }

  /**
   * Prices the trip and completes it. Priced with the tariff snapshotted at
   * booking (never today's tariff) on the actual trip: server-timed duration
   * and the GPS-trail distance, with the booked route as fallback and a cap
   * over the accepted estimate. The trip ends at `endRequestedAt` when the
   * driver asked to end it, so the wait for the rider's code is free.
   */
  private async finish(
    ride: RideDocument,
    options: {
      mode: RideCompletionMode;
      note?: string;
      /** The end OTP that was verified; the transition is guarded on it. */
      expectedCode?: string;
      actor: RideActor;
    },
  ): Promise<RideDocument | null> {
    const driverId = ride.driverId as Types.ObjectId;
    const completedAt = ride.endRequestedAt ?? new Date();
    const measurement =
      this.finalFareMode === "actual" && ride.startedAt
        ? measureTrip(
            await this.locations.tripTrail(
              ride._id,
              driverId,
              ride.startedAt,
              ride.endRequestedAt,
            ),
            this.tripMeterMaxGapSeconds,
          )
        : undefined;
    const priced = resolveFinalFare({
      mode: this.finalFareMode,
      rates: ride.fare,
      bookedDistanceMeters: ride.distanceMeters,
      bookedDurationSeconds: ride.durationSeconds,
      estimatedFare: ride.fare.estimatedFare,
      startedAt: ride.startedAt,
      completedAt,
      measurement,
      maxEstimateMultiplier: this.finalFareMaxEstimateMultiplier,
    });
    const finalFare = priced.total;
    // A promo applied at booking is priced again on the final fare with the
    // rules frozen on the ride (the admin may have edited the promo since).
    const discount = ride.promo ? computeDiscount(ride.promo, finalFare) : 0;
    const payableFare = finalFare - discount;
    const snapshot: RideFinalFare = {
      distanceMeters: priced.distanceMeters,
      durationSeconds: priced.durationSeconds,
      distanceSource: priced.distanceSource,
      durationSource: priced.durationSource,
      measuredDistanceMeters: priced.measuredDistanceMeters,
      baseFare: priced.breakdown.baseFare,
      distanceCharge: priced.breakdown.distanceCharge,
      timeCharge: priced.breakdown.timeCharge,
      subtotal: priced.breakdown.subtotal,
      minimumFareApplied: priced.breakdown.minimumFareApplied,
      capApplied: priced.capApplied,
      uncappedFare: priced.uncappedFare,
      total: finalFare,
      discount,
      payable: payableFare,
      pricingVersion: ride.fare.pricingVersion,
      mode: this.finalFareMode,
      computedAt: new Date(),
    };

    const completed = await this.transitions.apply({
      rideId: ride._id,
      from: RideStatus.RIDE_STARTED,
      to: RideStatus.COMPLETED,
      where: {
        driverId,
        // Guarded on the exact code verified, so a rotation or a second
        // verify of the same code cannot also complete the ride.
        ...(options.expectedCode ? { endOtpCode: options.expectedCode } : {}),
      },
      // Completing the trip opens the bill; it does not close it. The ride is
      // financially closed only when the payment is verified (Phase 4).
      set: {
        completedAt,
        completionMode: options.mode,
        ...(options.note ? { completionNote: options.note } : {}),
        ...(options.mode === RideCompletionMode.OTP
          ? { endOtpVerifiedAt: new Date() }
          : {}),
        "fare.finalFare": finalFare,
        "fare.final": snapshot,
        ...(ride.promo
          ? { "fare.discount": discount, "fare.payableFare": payableFare }
          : {}),
        paymentStatus:
          payableFare > 0
            ? RidePaymentStatus.PENDING
            : RidePaymentStatus.NOT_REQUIRED,
      },
      unset: ["endOtpCode", "endOtpExpiresAt"],
      actor: options.actor,
      reason: options.note,
      metadata: {
        finalFare,
        completionMode: options.mode,
        ...(ride.endCheck
          ? {
              farFromDestination: ride.endCheck.farFromDestination,
              distanceToDestinationMeters:
                ride.endCheck.distanceToDestinationMeters,
            }
          : {}),
        distanceMeters: priced.distanceMeters,
        distanceSource: priced.distanceSource,
        durationSeconds: priced.durationSeconds,
        ...(measurement
          ? {
              trail: {
                points: measurement.points,
                reliable: measurement.reliable,
                reason: measurement.reason,
              },
            }
          : {}),
        ...(priced.capApplied
          ? { capApplied: true, uncappedFare: priced.uncappedFare }
          : {}),
        ...(ride.promo
          ? { discount, payableFare, promoCode: ride.promo.code }
          : {}),
      },
    });
    if (!completed) return null;

    await this.matching.release(driverId, completed._id, {
      completedRide: true,
    });
    void this.locations.recordCheckpoint(
      completed._id,
      driverId,
      CheckpointKind.COMPLETED,
    );
    this.dispatch.kick();
    return completed;
  }

  /**
   * Checks the rider's end-of-trip code. Same rules as the start code: wrong
   * codes are counted; on lockout or expiry the code is rotated so a guessed
   * one is useless, and the rider's app receives the new one at once.
   * Returns the verified code (the transition is guarded on it).
   */
  private async verifyEndOtp(
    ride: RideDocument,
    submitted: string,
  ): Promise<string> {
    const expected = ride.endOtpCode;
    if (
      !expected ||
      !ride.endOtpExpiresAt ||
      ride.endOtpExpiresAt.getTime() <= Date.now()
    ) {
      await this.rotateEndOtp(ride, "OTP_EXPIRED");
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        "This code has expired. Ask the rider for the new code in their app.",
        "RIDE_OTP_EXPIRED",
      );
    }
    if (rideOtpMatches(submitted, expected)) return expected;

    const counted = await this.rideModel
      .findOneAndUpdate(
        {
          _id: ride._id,
          status: RideStatus.RIDE_STARTED,
          endOtpCode: expected,
        },
        { $inc: { endOtpAttempts: 1 } },
        { returnDocument: "after" },
      )
      .exec();
    const attempts = counted?.endOtpAttempts ?? this.otpMaxAttempts;
    if (attempts >= this.otpMaxAttempts) {
      await this.rotateEndOtp(ride, "OTP_LOCKED");
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        "Too many incorrect attempts. Ask the rider for the new code in their app.",
        "RIDE_OTP_TOO_MANY_ATTEMPTS",
      );
    }
    throw new ApiException(
      HttpStatus.BAD_REQUEST,
      "Incorrect code",
      "RIDE_OTP_INVALID",
      { attemptsRemaining: this.otpMaxAttempts - attempts },
    );
  }

  private async rotateEndOtp(
    ride: RideDocument,
    reason: string,
  ): Promise<void> {
    const rotated = await this.rideModel
      .updateOne(
        {
          _id: ride._id,
          status: RideStatus.RIDE_STARTED,
          endRequestedAt: { $exists: true },
        },
        {
          $set: {
            endOtpCode: generateRideOtp(),
            endOtpExpiresAt: new Date(Date.now() + this.otpTtlMs),
            endOtpAttempts: 0,
          },
          $inc: { stateVersion: 1 },
        },
      )
      .exec();
    // The rider's app shows the new code immediately — no poll needed.
    if (rotated.modifiedCount === 1)
      this.events.endOtpChanged(ride, RideEvent.OTP_REFRESHED);
    this.logger.warn(
      `Rotated end OTP for ride ${ride._id.toString()} (${reason})`,
    );
  }

  // ── Cancellation ──────────────────────────────────────────────────────

  /** What the cancel sheet shows: allowed?, reasons for this actor, and any fee right now. */
  async cancellationPreview(
    user: AuthenticatedUser,
    rideId: string,
  ): Promise<CancellationPreview> {
    const isDriver = user.role === UserRole.DRIVER;
    const driver = isDriver ? await this.driverFor(user.userId) : undefined;
    const owner: QueryFilter<Ride> = driver
      ? { driverId: driver._id }
      : { customerId: new Types.ObjectId(user.userId) };
    const ride = await this.rideModel.findOne({ ...owner, _id: rideId }).exec();
    if (!ride) throw rideNotFound();
    const cancellable = (
      isDriver ? DRIVER_CANCELLABLE_STATUSES : CUSTOMER_CANCELLABLE_STATUSES
    ).includes(ride.status);
    return this.cancellations.preview({
      actor: isDriver ? RideActorType.DRIVER : RideActorType.CUSTOMER,
      status: ride.status,
      cancellable,
      acceptedAt: ride.acceptedAt,
      fare: ride.fare.estimatedFare,
      currency: ride.fare.currency,
    });
  }

  /**
   * Cancellation: identify the actor → check the ride state → validate the
   * reason → assess the fee (server policy) → compare-and-set to CANCELLED
   * with the fee on the ride → record the cancellation → free the driver.
   * Notifications and promo release follow from the ride.transitioned event.
   */
  async cancel(
    user: AuthenticatedUser,
    rideId: string,
    input: { reasonCode?: string; note?: string } = {},
  ): Promise<CustomerRideView | DriverRideView> {
    const isDriver = user.role === UserRole.DRIVER;
    const driver = isDriver ? await this.driverFor(user.userId) : undefined;
    const owner: QueryFilter<Ride> = driver
      ? { driverId: driver._id }
      : { customerId: new Types.ObjectId(user.userId) };
    const cancellable = isDriver
      ? DRIVER_CANCELLABLE_STATUSES
      : CUSTOMER_CANCELLABLE_STATUSES;
    const actor = this.actorFor(
      user.userId,
      isDriver ? RideActorType.DRIVER : RideActorType.CUSTOMER,
    );
    let reason: ResolvedReason | undefined;

    // Optimistic loop: the status can move under us (driver accepts while the
    // customer taps cancel). Re-read and re-check rather than guess.
    for (let attempt = 0; attempt < MAX_CANCEL_RETRIES; attempt += 1) {
      const ride = await this.rideModel
        .findOne({ ...owner, _id: rideId })
        .exec();
      if (!ride) throw rideNotFound();
      if (!cancellable.includes(ride.status))
        throw rideConflict(
          isDriver && ride.status === RideStatus.DRIVER_ASSIGNED
            ? "Reject the request instead of cancelling it"
            : `A ride that is ${this.describe(ride.status)} cannot be cancelled`,
          ride.status,
          "RIDE_NOT_CANCELLABLE",
        );

      // Validated only once the ride is known to be cancellable, so a wrong
      // state is reported as such rather than as a bad reason.
      reason ??= await this.cancellations.resolveReason(
        actor.type,
        input.reasonCode,
        input.note,
      );
      // Assessed against the status we are about to leave; the transition is
      // conditional on that same status, so the fee cannot go stale.
      const fee = await this.cancellations.assess({
        actor: actor.type,
        status: ride.status,
        acceptedAt: ride.acceptedAt,
        fare: ride.fare.estimatedFare,
      });
      const feeAmount = fee.applies ? fee.amount : 0;
      const reasonText = reason.note
        ? `${reason.label}: ${reason.note}`
        : reason.label;

      const cancelled = await this.transitions.apply({
        rideId: ride._id,
        from: ride.status,
        to: RideStatus.CANCELLED,
        where: owner,
        set: {
          cancelledAt: new Date(),
          cancellation: {
            cancelledBy: actor.type,
            cancelledByUserId: actor.userId,
            reason: reasonText,
            reasonCode: reason.code,
            note: reason.note,
            feeAmount,
            feeStatus:
              feeAmount > 0
                ? CancellationFeeStatus.DUE
                : CancellationFeeStatus.NOT_APPLICABLE,
          },
        },
        unset: ["otpCode", "otpExpiresAt", "assignmentExpiresAt"],
        actor,
        reason: reasonText,
        metadata: {
          reasonCode: reason.code,
          ...(feeAmount > 0
            ? { cancellationFee: feeAmount, policyVersion: fee.policyVersion }
            : {}),
        },
      });
      if (!cancelled) continue;

      await this.cancellations.record(cancelled, {
        cancelledBy: actor.type,
        cancelledByUserId: actor.userId as Types.ObjectId,
        reason,
        statusAtCancellation: ride.status,
        feeAmount,
        policyVersion: fee.policyVersion,
      });

      if (ride.driverId) {
        await this.matching.release(ride.driverId, ride._id);
        if (ride.acceptedAt)
          void this.locations.recordCheckpoint(
            ride._id,
            ride.driverId,
            CheckpointKind.CANCELLED,
          );
        this.dispatch.kick();
      }
      return driver
        ? this.views.forDriver(cancelled, driver)
        : this.views.forCustomer(cancelled);
    }
    const latest = await this.rideModel
      .findOne({ ...owner, _id: rideId })
      .exec();
    throw rideConflict(
      "The ride changed while cancelling. Please try again.",
      latest?.status ?? RideStatus.CANCELLED,
      "RIDE_STATE_CONFLICT",
    );
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  private async driverFor(
    driverUserId: string,
  ): Promise<DriverProfileDocument> {
    const driver = await this.rides.resolveDriver(driverUserId);
    await this.matching.touch(driver._id);
    return driver;
  }

  private actorFor(userId: string, type: RideActorType): RideActor {
    return { type, userId: new Types.ObjectId(userId) };
  }

  private async rotateOtp(
    rideId: Types.ObjectId,
    reason: string,
  ): Promise<void> {
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
    const wasOfferedToMe =
      assignedToMe ||
      ride.rejectedDriverIds.some((id) => id.equals(driver._id));
    if (!wasOfferedToMe)
      // A driver who was never offered the ride learns nothing about it —
      // except the classic race loser, who gets the conflict the spec wants.
      return ride.status === RideStatus.DRIVER_ASSIGNED ||
        ride.status === RideStatus.DRIVER_ACCEPTED
        ? rideConflict(
            "This ride is no longer available",
            ride.status,
            "RIDE_STATE_CONFLICT",
          )
        : rideNotFound();

    if (!assignedToMe)
      return rideConflict(
        "This request is no longer assigned to you",
        ride.status,
        "RIDE_STATE_CONFLICT",
      );

    if (ride.status === RideStatus.DRIVER_ASSIGNED) {
      // Offer lapsed between the driver's last poll and the tap.
      await this.dispatch.settle(ride);
      return rideConflict(
        "This request has expired",
        RideStatus.SEARCHING,
        "RIDE_STATE_CONFLICT",
      );
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
    const ride = await this.rideModel
      .findOne({ _id: rideId, driverId: driver._id })
      .exec();
    if (!ride) return rideNotFound();
    return rideConflict(
      this.wrongStateMessage(action, ride.status),
      ride.status,
    );
  }

  private wrongStateMessage(action: string, status: RideStatus): string {
    return `Cannot ${action} a ride that is ${this.describe(status)}`;
  }

  private describe(status: RideStatus): string {
    return status.toLowerCase().replace(/_/g, " ");
  }
}
