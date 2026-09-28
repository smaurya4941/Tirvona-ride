import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { Ride, RideSchema } from "../rides/schemas/ride.schema";
import { User, UserSchema } from "../users/schemas/user.schema";
import { CancellationsService } from "./cancellations.service";
import {
  Cancellation,
  CancellationPolicy,
  CancellationPolicySchema,
  CancellationReason,
  CancellationReasonSchema,
  CancellationSchema,
} from "./schemas/cancellation.schemas";

// Leaf module: Rides → Cancellations. The Ride model is registered by schema
// only (to keep the fee status on the ride in step), never RidesModule.
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: CancellationReason.name, schema: CancellationReasonSchema },
      { name: CancellationPolicy.name, schema: CancellationPolicySchema },
      { name: Cancellation.name, schema: CancellationSchema },
      { name: Ride.name, schema: RideSchema },
      { name: User.name, schema: UserSchema },
    ]),
  ],
  providers: [CancellationsService],
  exports: [CancellationsService, MongooseModule],
})
export class CancellationsModule {}
