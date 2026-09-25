import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import type { Model, QueryFilter } from "mongoose";
import { Types } from "mongoose";
import { UserRole } from "../../common/types/user-role.enum";
import { DRIVER_ENGAGED_STATUSES } from "../rides/ride-state-machine";
import type { RideStatus } from "../rides/ride-state-machine";
import { Ride } from "../rides/schemas/ride.schema";
import type { SocketIdentity } from "./realtime.types";

export type RoomAccess =
  | { allowed: true; rideId: string; status: RideStatus; stateVersion: number }
  | { allowed: false; reason: "RIDE_NOT_FOUND" | "RIDE_NOT_ACTIVE"; status?: RideStatus };

/**
 * Who may be in `ride:{id}`: its customer while the ride is active, and its
 * driver once they have accepted (DRIVER_ACCEPTED → RIDE_STARTED). A merely
 * *offered* driver is not a member — offers arrive on their user room.
 */
@Injectable()
export class RideRoomAccessService {
  constructor(@InjectModel(Ride.name) private readonly rideModel: Model<Ride>) {}

  async check(identity: SocketIdentity, rideId: string): Promise<RoomAccess> {
    if (!Types.ObjectId.isValid(rideId)) return { allowed: false, reason: "RIDE_NOT_FOUND" };
    const owner = this.ownerFilter(identity);
    if (!owner) return { allowed: false, reason: "RIDE_NOT_FOUND" };

    const ride = await this.rideModel
      .findOne({ ...owner, _id: new Types.ObjectId(rideId) })
      .select("status isActive stateVersion")
      .lean()
      .exec();
    // Same answer for "missing" and "not yours": never confirm another ride exists.
    if (!ride) return { allowed: false, reason: "RIDE_NOT_FOUND" };

    const member =
      identity.role === UserRole.CUSTOMER ? ride.isActive : DRIVER_ENGAGED_STATUSES.includes(ride.status);
    if (!member) return { allowed: false, reason: "RIDE_NOT_ACTIVE", status: ride.status };
    return { allowed: true, rideId, status: ride.status, stateVersion: ride.stateVersion ?? 0 };
  }

  /** Rooms restored automatically on every (re)connect. */
  async activeRideIds(identity: SocketIdentity): Promise<string[]> {
    const owner = this.ownerFilter(identity);
    if (!owner) return [];
    const filter: QueryFilter<Ride> =
      identity.role === UserRole.CUSTOMER
        ? { ...owner, isActive: true }
        : { ...owner, status: { $in: DRIVER_ENGAGED_STATUSES } };
    const rides = await this.rideModel.find(filter).select("_id").lean().exec();
    return rides.map((ride) => ride._id.toString());
  }

  private ownerFilter(identity: SocketIdentity): QueryFilter<Ride> | null {
    if (identity.role === UserRole.CUSTOMER) return { customerId: new Types.ObjectId(identity.userId) };
    return identity.driverId ? { driverId: new Types.ObjectId(identity.driverId) } : null;
  }
}
