import { Injectable, Logger } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import type { Model } from "mongoose";
import { Types } from "mongoose";
import { DomainEventsService } from "../../infrastructure/events/domain-events.service";
import { rideSnapshot } from "../../infrastructure/events/ride-snapshot";
import { DriverProfile } from "../drivers/schemas/driver-profile.schema";
import { RideEvent } from "../realtime/realtime.constants";
import type { RideEventName } from "../realtime/realtime.constants";
import { RealtimeService } from "../realtime/realtime.service";
import type { RealtimeEnvelope, RideDelivery } from "../realtime/realtime.types";
import { inRideRoom, planRideEvents } from "./ride-events";
import { RideStatus } from "./ride-state-machine";
import { RideViewService } from "./ride-view.service";
import { Ride } from "./schemas/ride.schema";
import type { RideDocument } from "./schemas/ride.schema";

export interface CommittedTransition {
  ride: RideDocument;
  from?: RideStatus;
  to: RideStatus;
  reason?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Turns committed ride changes into realtime events.
 *
 * Called by RideTransitionService after every successful compare-and-set, so
 * *every* state change produces its event and nothing else can produce one.
 * Publishing is fire-and-forget (a socket problem must never fail a REST
 * action) but strictly ordered per ride through a promise chain, so a
 * customer never sees `ride.started` before `ride.driver_arrived`.
 */
@Injectable()
export class RideEventsService {
  private readonly logger = new Logger(RideEventsService.name);
  private readonly queues = new Map<string, Promise<void>>();

  constructor(
    @InjectModel(Ride.name) private readonly rideModel: Model<Ride>,
    @InjectModel(DriverProfile.name) private readonly driverModel: Model<DriverProfile>,
    private readonly views: RideViewService,
    private readonly realtime: RealtimeService,
    private readonly domainEvents: DomainEventsService,
  ) {}

  /** A new booking (no `from`). */
  created(ride: RideDocument): void {
    this.transitioned({ ride, to: RideStatus.SEARCHING });
  }

  transitioned(transition: CommittedTransition): void {
    // Domain consumers (notifications, share links) — independent of sockets.
    this.domainEvents.emit("ride.transitioned", {
      ride: rideSnapshot(transition.ride),
      from: transition.from,
      to: transition.to,
      reason: transition.reason,
      metadata: transition.metadata,
    });
    this.enqueue(transition.ride._id, () => this.publishTransition(transition));
  }

  /** The start-of-trip OTP rotated; only the customer's view changes. */
  otpRefreshed(rideId: Types.ObjectId): void {
    this.enqueue(rideId, async () => {
      const ride = await this.rideModel.findById(rideId).select("+otpCode").exec();
      if (!ride || ride.status !== RideStatus.DRIVER_ARRIVED) return;
      await this.realtime.deliver(ride._id.toString(), [
        {
          userId: ride.customerId.toString(),
          room: "join",
          envelope: this.envelope(RideEvent.OTP_REFRESHED, ride, {}, await this.views.forCustomer(ride)),
        },
      ]);
    });
  }

  /**
   * The ride's payment status changed. The customer and the ride's driver
   * each get their own ride view; `room: "keep"` because a paid/unpaid
   * completed ride has no live room to join or leave.
   */
  paymentUpdated(rideId: Types.ObjectId, data: Record<string, unknown>, committed?: RideDocument): void {
    if (committed)
      this.domainEvents.emit("ride.payment_updated", {
        ride: rideSnapshot(committed),
        paymentStatus: committed.paymentStatus,
        amount: committed.payment?.amount,
      });
    this.enqueue(rideId, async () => {
      const ride = await this.rideModel.findById(rideId).exec();
      if (!ride) return;
      const deliveries: RideDelivery[] = [
        {
          userId: ride.customerId.toString(),
          room: "keep",
          envelope: this.envelope(RideEvent.PAYMENT_UPDATED, ride, data, await this.views.forCustomer(ride)),
        },
      ];
      if (ride.driverId && ride.driverUserId) {
        const driver = await this.driverModel.findById(ride.driverId).exec();
        if (driver)
          deliveries.push({
            userId: ride.driverUserId.toString(),
            room: "keep",
            envelope: this.envelope(RideEvent.PAYMENT_UPDATED, ride, data, await this.views.forDriver(ride, driver)),
          });
      }
      await this.realtime.deliver(ride._id.toString(), deliveries);
    });
  }

  /** Resolves when every queued publication has run (tests, shutdown). */
  async drain(): Promise<void> {
    while (this.queues.size) await Promise.all([...this.queues.values()]);
  }

  private enqueue(rideId: Types.ObjectId, task: () => Promise<void>): void {
    if (!this.realtime.isAttached) return;
    const key = rideId.toString();
    const next = (this.queues.get(key) ?? Promise.resolve()).then(task).catch((error: unknown) => {
      this.logger.error(
        `Realtime publish failed for ride ${key}`,
        error instanceof Error ? error.stack : String(error),
      );
    });
    this.queues.set(key, next);
    void next.finally(() => {
      if (this.queues.get(key) === next) this.queues.delete(key);
    });
  }

  private async publishTransition({ ride, from, to, reason, metadata }: CommittedTransition): Promise<void> {
    const plan = planRideEvents(from, to);
    const rideId = ride._id.toString();
    const data: Record<string, unknown> = {};
    if (reason) data.reason = reason;
    if (ride.driverId) data.driverId = ride.driverId.toString();

    const deliveries: RideDelivery[] = [];

    // Customer — their own view, including the OTP once the driver arrived.
    const customerRide = to === RideStatus.DRIVER_ARRIVED ? await this.withOtp(ride) : ride;
    deliveries.push({
      userId: ride.customerId.toString(),
      room: inRideRoom(to, "customer") ? "join" : "leave",
      envelope: this.envelope(plan.customer, ride, data, await this.views.forCustomer(customerRide)),
    });

    // Current driver — their own view (never the OTP).
    if (plan.driver && ride.driverId && ride.driverUserId) {
      const driver = await this.driverModel.findById(ride.driverId).exec();
      if (driver)
        deliveries.push({
          userId: ride.driverUserId.toString(),
          room: inRideRoom(to, "driver") ? "join" : "leave",
          envelope: this.envelope(plan.driver, ride, data, await this.views.forDriver(ride, driver)),
        });
    }

    // Driver who just lost the offer (rejected / timed out / went offline).
    if (plan.previousDriver && typeof metadata?.driverId === "string" && Types.ObjectId.isValid(metadata.driverId)) {
      const previous = await this.driverModel.findById(metadata.driverId).select("userId").lean().exec();
      if (previous)
        deliveries.push({
          userId: previous.userId.toString(),
          room: "leave",
          // No ride view: the ride is no longer theirs to see.
          envelope: {
            event: plan.previousDriver,
            rideId,
            timestamp: new Date().toISOString(),
            data: { reason: reason ?? "OFFER_WITHDRAWN" },
          },
        });
    }

    await this.realtime.deliver(rideId, deliveries);
    if (plan.closeRoom) this.realtime.closeRideRoom(rideId);
  }

  private envelope(
    event: RideEventName,
    ride: RideDocument,
    data: Record<string, unknown>,
    view: unknown,
  ): RealtimeEnvelope {
    return {
      event,
      rideId: ride._id.toString(),
      status: ride.status,
      stateVersion: ride.stateVersion ?? 0,
      timestamp: new Date().toISOString(),
      data,
      ride: view,
    };
  }

  /** The transition result never carries `otpCode` (select: false). */
  private async withOtp(ride: RideDocument): Promise<RideDocument> {
    const withCode = await this.rideModel
      .findOne({ _id: ride._id, status: RideStatus.DRIVER_ARRIVED })
      .select("+otpCode")
      .exec();
    return withCode ?? ride;
  }
}
