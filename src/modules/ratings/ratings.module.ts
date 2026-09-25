import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { DriverProfile, DriverProfileSchema } from "../drivers/schemas/driver-profile.schema";
import { Ride, RideSchema } from "../rides/schemas/ride.schema";
import { User, UserSchema } from "../users/schemas/user.schema";
import { DriverRatingsController, RideRatingsController } from "./ratings.controller";
import { RatingsService } from "./ratings.service";
import { Rating, RatingSchema } from "./schemas/rating.schema";

// Ratings reads rides/drivers/users by schema only; nothing imports it
// except Admin. The driver aggregate lives on driver_profiles.
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Rating.name, schema: RatingSchema },
      { name: Ride.name, schema: RideSchema },
      { name: DriverProfile.name, schema: DriverProfileSchema },
      { name: User.name, schema: UserSchema },
    ]),
  ],
  controllers: [RideRatingsController, DriverRatingsController],
  providers: [RatingsService],
  exports: [RatingsService],
})
export class RatingsModule {}
