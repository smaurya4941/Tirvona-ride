import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { DriverProfile, DriverProfileSchema } from "../drivers/schemas/driver-profile.schema";
import { NotificationsModule } from "../notifications/notifications.module";
import { Ride, RideSchema } from "../rides/schemas/ride.schema";
import { UsersModule } from "../users/users.module";
import { ComplaintsController } from "./complaints.controller";
import { ComplaintsService } from "./complaints.service";
import { SupportTicket, SupportTicketSchema } from "./schemas/support-ticket.schema";

// Complaints → Notifications, Users(model), Rides/Drivers(schemas only).
// Admin → Complaints.
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: SupportTicket.name, schema: SupportTicketSchema },
      { name: Ride.name, schema: RideSchema },
      { name: DriverProfile.name, schema: DriverProfileSchema },
    ]),
    UsersModule,
    NotificationsModule,
  ],
  controllers: [ComplaintsController],
  providers: [ComplaintsService],
  exports: [ComplaintsService],
})
export class ComplaintsModule {}
