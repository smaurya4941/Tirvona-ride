import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { RealtimeModule } from "../realtime/realtime.module";
import { Ride, RideSchema } from "../rides/schemas/ride.schema";
import { UsersModule } from "../users/users.module";
import { DeviceTokensService } from "./device-tokens.service";
import { NotificationEventsListener } from "./notification-events.listener";
import { NotificationsController } from "./notifications.controller";
import { NotificationsService } from "./notifications.service";
import { FcmHttpGateway } from "./push/fcm-http.gateway";
import { PushGateway } from "./push/push.gateway";
import { DeviceToken, DeviceTokenSchema } from "./schemas/device-token.schema";
import { Notification, NotificationSchema } from "./schemas/notification.schema";
import { Broadcast, BroadcastSchema } from "./broadcasts/broadcast.schema";
import { BroadcastsService } from "./broadcasts/broadcasts.service";
import { DriverProfile, DriverProfileSchema } from "../drivers/schemas/driver-profile.schema";

// Dependency direction (no cycles):
//   Notifications → Realtime, Users(model), Rides(schema only)
// Rides/Payments/Auth never import Notifications: they publish domain
// events, which NotificationEventsListener consumes. Safety, Ratings and
// Complaints call NotificationsService directly.
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Notification.name, schema: NotificationSchema },
      { name: DeviceToken.name, schema: DeviceTokenSchema },
      { name: Ride.name, schema: RideSchema },
      { name: Broadcast.name, schema: BroadcastSchema },
      { name: DriverProfile.name, schema: DriverProfileSchema },
    ]),
    UsersModule,
    RealtimeModule,
  ],
  controllers: [NotificationsController],
  providers: [
    { provide: PushGateway, useClass: FcmHttpGateway },
    NotificationsService,
    DeviceTokensService,
    NotificationEventsListener,
    BroadcastsService,
  ],
  exports: [NotificationsService, DeviceTokensService, BroadcastsService],
})
export class NotificationsModule {}
