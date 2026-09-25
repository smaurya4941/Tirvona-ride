import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectModel } from "@nestjs/mongoose";
import type { Model, Types } from "mongoose";
import { DriverProfile, DriverStatus } from "../drivers/schemas/driver-profile.schema";
import { toGeoJsonPoint } from "../locations/geo";
import type { GeoCoordinates } from "../locations/geo";
import type { VehicleType } from "../vehicles/schemas/vehicle.schema";

export interface DriverCandidate {
  driverId: Types.ObjectId;
  userId: Types.ObjectId;
  activeVehicleId?: Types.ObjectId;
  distanceMeters: number;
}

export interface CandidateQuery {
  pickup: GeoCoordinates;
  vehicleType: VehicleType;
  excludeDriverIds?: Types.ObjectId[];
  limit?: number;
}

/**
 * Driver-side half of dispatch: who is eligible, who is nearest, and the
 * atomic reserve/release of a driver. Knows nothing about rides beyond an id,
 * which keeps RidesModule → MatchingModule a one-way dependency.
 *
 * MongoDB $geoNear over a 2dsphere index (Phase 2, kept in Phase 3). Redis
 * GEO can later replace the candidate search without changing this contract.
 */
@Injectable()
export class MatchingService {
  private readonly radiusMeters: number;
  private readonly locationStaleMs: number;

  constructor(
    @InjectModel(DriverProfile.name) private readonly driverModel: Model<DriverProfile>,
    config: ConfigService,
  ) {
    this.radiusMeters = config.getOrThrow<number>("matchingRadiusKm") * 1000;
    this.locationStaleMs = config.getOrThrow<number>("driverLocationStaleSeconds") * 1000;
  }

  /**
   * Eligible = approved AND online AND available AND not reserved AND serving
   * the right vehicle type AND a recent location AND within the radius.
   * Sorted nearest first by $geoNear itself.
   *
   * "Recent location" replaces the Phase 2 polling heartbeat: a driver whose
   * app stopped streaming GPS (killed, no signal, no network) stops being
   * matchable after DRIVER_LOCATION_STALE_SECONDS, even though isOnline is
   * still true.
   */
  async findCandidates(query: CandidateQuery): Promise<DriverCandidate[]> {
    return this.driverModel
      .aggregate<DriverCandidate>([
        {
          $geoNear: {
            near: toGeoJsonPoint(query.pickup),
            key: "currentLocation",
            distanceField: "distanceMeters",
            maxDistance: this.radiusMeters,
            spherical: true,
            query: {
              driverStatus: DriverStatus.APPROVED,
              isOnline: true,
              isAvailable: true,
              currentRideId: null,
              activeVehicleType: query.vehicleType,
              locationUpdatedAt: { $gte: new Date(Date.now() - this.locationStaleMs) },
              ...(query.excludeDriverIds?.length
                ? { _id: { $nin: query.excludeDriverIds } }
                : {}),
            },
          },
        },
        { $limit: query.limit ?? 5 },
        {
          $project: {
            _id: 0,
            driverId: "$_id",
            userId: 1,
            activeVehicleId: 1,
            distanceMeters: 1,
          },
        },
      ])
      .exec();
  }

  /**
   * Compare-and-set: succeeds only if the driver is still free. Two rides
   * dispatched concurrently can both pick the same nearest driver; exactly
   * one reservation wins and the other moves on to its next candidate.
   */
  async reserve(driverId: Types.ObjectId, rideId: Types.ObjectId): Promise<boolean> {
    const result = await this.driverModel
      .updateOne(
        {
          _id: driverId,
          driverStatus: DriverStatus.APPROVED,
          isOnline: true,
          isAvailable: true,
          currentRideId: null,
        },
        { $set: { isAvailable: false, currentRideId: rideId } },
      )
      .exec();
    return result.modifiedCount === 1;
  }

  /**
   * Frees a driver held for `rideId`. Guarded on currentRideId so a stale
   * release can never free a driver who has since moved on to another ride.
   * The driver becomes available only if still online.
   */
  async release(
    driverId: Types.ObjectId,
    rideId: Types.ObjectId,
    options: { completedRide?: boolean } = {},
  ): Promise<void> {
    const inc = options.completedRide ? { $inc: { totalRides: 1 } } : {};
    const online = await this.driverModel
      .updateOne(
        { _id: driverId, currentRideId: rideId, isOnline: true },
        { $set: { isAvailable: true, lastSeenAt: new Date() }, $unset: { currentRideId: 1 }, ...inc },
      )
      .exec();
    if (online.modifiedCount === 1) return;
    await this.driverModel
      .updateOne(
        { _id: driverId, currentRideId: rideId },
        { $set: { isAvailable: false }, $unset: { currentRideId: 1 }, ...inc },
      )
      .exec();
  }

  /** Heartbeat: the driver app is alive. */
  async touch(driverId: Types.ObjectId): Promise<void> {
    await this.driverModel
      .updateOne({ _id: driverId }, { $set: { lastSeenAt: new Date() } })
      .exec();
  }
}
