import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { DriverProfile, DriverProfileSchema } from "../drivers/schemas/driver-profile.schema";
import { LocationsModule } from "../locations/locations.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { Ride, RideSchema } from "../rides/schemas/ride.schema";
import { UsersModule } from "../users/users.module";
import { EmergencyContactsController, RideSafetyController, SharedRidesController } from "./safety.controller";
import { EmergencyContactsService } from "./emergency-contacts.service";
import { EmergencyContact, EmergencyContactSchema } from "./schemas/emergency-contact.schema";
import { RideShareToken, RideShareTokenSchema } from "./schemas/ride-share-token.schema";
import { SosEvent, SosEventSchema } from "./schemas/sos-event.schema";
import { ShareRideService } from "./share-ride.service";
import { SosService } from "./sos.service";

// Dependency direction (no cycles):
//   Safety → Notifications, Locations, Users(model), Rides/Drivers(schemas only)
//   Admin → Safety
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: SosEvent.name, schema: SosEventSchema },
      { name: EmergencyContact.name, schema: EmergencyContactSchema },
      { name: RideShareToken.name, schema: RideShareTokenSchema },
      { name: Ride.name, schema: RideSchema },
      { name: DriverProfile.name, schema: DriverProfileSchema },
    ]),
    UsersModule,
    LocationsModule,
    NotificationsModule,
  ],
  controllers: [EmergencyContactsController, RideSafetyController, SharedRidesController],
  providers: [EmergencyContactsService, SosService, ShareRideService],
  exports: [SosService, EmergencyContactsService],
})
export class SafetyModule {}
