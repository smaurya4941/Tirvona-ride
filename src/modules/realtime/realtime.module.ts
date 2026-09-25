import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { MongooseModule } from "@nestjs/mongoose";
import { DriverProfile, DriverProfileSchema } from "../drivers/schemas/driver-profile.schema";
import { LocationsModule } from "../locations/locations.module";
import { Ride, RideSchema } from "../rides/schemas/ride.schema";
import { User, UserSchema } from "../users/schemas/user.schema";
import { LocationRelayService } from "./location-relay.service";
import { RealtimeGateway } from "./realtime.gateway";
import { RealtimeService } from "./realtime.service";
import { RideRoomAccessService } from "./ride-room-access.service";
import { SocketAuthService } from "./socket-auth.service";

// Dependency direction (no cycles):
//   Rides → Realtime → Locations
// Realtime reads rides/users/drivers by schema only and never imports
// RidesModule; ride events are *pushed into* it by RideEventsService.
@Module({
  imports: [
    JwtModule.register({}),
    MongooseModule.forFeature([
      { name: Ride.name, schema: RideSchema },
      { name: User.name, schema: UserSchema },
      { name: DriverProfile.name, schema: DriverProfileSchema },
    ]),
    LocationsModule,
  ],
  providers: [RealtimeGateway, RealtimeService, SocketAuthService, RideRoomAccessService, LocationRelayService],
  exports: [RealtimeService, LocationRelayService],
})
export class RealtimeModule {}
