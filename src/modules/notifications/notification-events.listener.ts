import { Injectable } from "@nestjs/common";
import type { OnModuleInit } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import type { Model } from "mongoose";
import { UserRole } from "../../common/types/user-role.enum";
import type { RideSnapshot } from "../../infrastructure/events/domain-events";
import { DomainEventsService } from "../../infrastructure/events/domain-events.service";
import { rideSnapshot } from "../../infrastructure/events/ride-snapshot";
import { Ride } from "../rides/schemas/ride.schema";
import { User } from "../users/schemas/user.schema";
import { DeviceTokensService } from "./device-tokens.service";
import {
  planArrivingNotification,
  planPaymentNotifications,
  planRideNotifications,
} from "./notification-plan";
import type { RideNotificationContext } from "./notification-plan";
import { NotificationType } from "./notification-types";
import { NotificationsService } from "./notifications.service";

/**
 * Subscribes to committed domain events and turns them into notifications.
 * Controllers and ride/payment services never build notifications
 * themselves; the matrix lives in notification-plan.ts.
 */
@Injectable()
export class NotificationEventsListener implements OnModuleInit {
  constructor(
    private readonly events: DomainEventsService,
    private readonly notifications: NotificationsService,
    private readonly deviceTokens: DeviceTokensService,
    @InjectModel(Ride.name) private readonly rideModel: Model<Ride>,
    @InjectModel(User.name) private readonly userModel: Model<User>,
  ) {}

  onModuleInit(): void {
    this.events.on("ride.transitioned", async (event) => {
      const drafts = planRideNotifications(event, await this.context(event.ride));
      if (drafts.length) await this.notifications.notify(drafts);
    });

    this.events.on("ride.driver_arriving", async (event) => {
      const ride = await this.rideModel.findById(event.rideId).exec();
      if (!ride) return;
      const snapshot = rideSnapshot(ride);
      await this.notifications.notify([
        planArrivingNotification(snapshot, event.etaSeconds, await this.context(snapshot)),
      ]);
    });

    this.events.on("ride.payment_updated", async (event) => {
      const drafts = planPaymentNotifications(event.ride, event.paymentStatus, event.amount);
      if (drafts.length) await this.notifications.notify(drafts);
    });

    this.events.on("driver.reviewed", async (event) => {
      await this.notifications.notify([
        event.approved
          ? {
              userId: event.userId,
              recipientRole: UserRole.DRIVER,
              type: NotificationType.DRIVER_APPROVED,
              title: "You're approved!",
              message: "Your documents are verified. Go online to start receiving rides.",
              referenceId: event.driverId,
              data: { driverId: event.driverId },
            }
          : {
              userId: event.userId,
              recipientRole: UserRole.DRIVER,
              type: NotificationType.DRIVER_REJECTED,
              title: "Application needs changes",
              message: event.reason
                ? `Your application was not approved: ${event.reason}. Update your details and resubmit.`
                : "Your application was not approved. Update your details and resubmit.",
              referenceId: event.driverId,
              data: { driverId: event.driverId },
            },
      ]);
    });

    // Belt and braces with the app's own unregister call on sign out.
    this.events.on("auth.logged_out", async (event) => {
      if (event.deviceId) await this.deviceTokens.deactivateDevice(event.userId, event.deviceId);
    });
  }

  private async context(ride: RideSnapshot): Promise<RideNotificationContext> {
    if (!ride.driverUserId) return {};
    const [driverUser, rideDoc] = await Promise.all([
      this.userModel.findById(ride.driverUserId).select("firstName").lean().exec(),
      this.rideModel.findById(ride.rideId).select("vehicle.registrationNumber").lean().exec(),
    ]);
    return {
      driverName: driverUser?.firstName,
      vehiclePlate: rideDoc?.vehicle?.registrationNumber,
    };
  }
}
