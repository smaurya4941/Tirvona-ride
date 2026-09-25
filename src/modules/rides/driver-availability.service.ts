import { HttpStatus, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectModel } from "@nestjs/mongoose";
import type { Model } from "mongoose";
import { Types } from "mongoose";
import { ApiException, apiBadRequest, apiForbidden } from "../../common/exceptions/api.exception";
import { startOfDayInTimeZone } from "../../common/utils/time";
import { DriverProfile } from "../drivers/schemas/driver-profile.schema";
import { EarningsService } from "../earnings/earnings.service";
import type { DriverProfileDocument } from "../drivers/schemas/driver-profile.schema";
import type { DriverLocationFixDto } from "../locations/dto/driver-location-fix.dto";
import { DriverLocationService } from "../locations/driver-location.service";
import type { LocationRejection } from "../locations/driver-location.service";
import { fromGeoJsonPoint, toGeoJsonPoint } from "../locations/geo";
import { LocationRelayService } from "../realtime/location-relay.service";
import type { GeoCoordinates } from "../locations/geo";
import { UserStatus } from "../users/schemas/user.schema";
import { UsersService } from "../users/users.service";
import { Vehicle } from "../vehicles/schemas/vehicle.schema";
import type { VehicleDocument } from "../vehicles/schemas/vehicle.schema";
import type { UpdateAvailabilityDto } from "./dto/driver-duty.dto";
import { RideDispatchService } from "./ride-dispatch.service";
import { DRIVER_ENGAGED_STATUSES, RideActorType, RideStatus } from "./ride-state-machine";
import { RideViewService } from "./ride-view.service";
import type { DriverRideView } from "./ride-view.service";
import { RidesService } from "./rides.service";
import { Ride } from "./schemas/ride.schema";

export interface DriverDutyStatus {
  isOnline: boolean;
  isAvailable: boolean;
  location?: GeoCoordinates & { updatedAt?: Date };
  /**
   * Whether the stored location is recent enough for matching
   * (DRIVER_LOCATION_STALE_SECONDS). Online + available + fresh = matchable.
   */
  locationFresh: boolean;
  vehicle?: { id: string; vehicleType: string; registrationNumber: string; make?: string; model?: string };
  currentRideId?: string;
  wentOnlineAt?: Date;
}

export interface DriverDashboard extends DriverDutyStatus {
  driverCode: string;
  ratingAverage: number;
  ratingCount: number;
  totalRides: number;
  /**
   * Today (business day). `grossFares`: fares of rides completed today.
   * `earnings`: the driver's net share from the ledger — paid rides only.
   */
  today: {
    completedRides: number;
    grossFares: number;
    earnings: number;
    paidRides: number;
    currency: string;
  };
  /** The ride the driver is working on (accepted → started), if any. */
  currentRide: DriverRideView | null;
  /** Number of requests awaiting accept/reject (0 or 1 in Phase 2). */
  pendingRequests: number;
}

@Injectable()
export class DriverAvailabilityService {
  private readonly timeZone: string;

  constructor(
    @InjectModel(DriverProfile.name) private readonly driverModel: Model<DriverProfile>,
    @InjectModel(Vehicle.name) private readonly vehicleModel: Model<Vehicle>,
    @InjectModel(Ride.name) private readonly rideModel: Model<Ride>,
    private readonly rides: RidesService,
    private readonly users: UsersService,
    private readonly dispatch: RideDispatchService,
    private readonly views: RideViewService,
    private readonly locations: DriverLocationService,
    private readonly relay: LocationRelayService,
    private readonly earnings: EarningsService,
    config: ConfigService,
  ) {
    this.timeZone = config.getOrThrow<string>("appTimeZone");
  }

  async setAvailability(driverUserId: string, dto: UpdateAvailabilityDto): Promise<DriverDutyStatus> {
    const driver = await this.rides.resolveDriver(driverUserId);
    return dto.isOnline ? this.goOnline(driverUserId, driver, dto) : this.goOffline(driverUserId, driver);
  }

  /**
   * REST fallback for `driver.location` (socket unavailable). Same pipeline:
   * validated, relayed to the ride room, persisted only when due.
   */
  async updateLocation(driverUserId: string, dto: DriverLocationFixDto): Promise<DriverDutyStatus> {
    const driver = await this.rides.resolveDriver(driverUserId);
    const result = await this.relay.handle(driver._id.toString(), dto, { enforceRateLimit: false });
    if (!result.accepted) throw this.locationRejected(result.reason);
    const updated = await this.driverModel.findById(driver._id).exec();
    return this.toStatus(updated ?? driver);
  }

  async dashboard(driverUserId: string): Promise<DriverDashboard> {
    const driver = await this.rides.resolveDriver(driverUserId);
    const since = startOfDayInTimeZone(new Date(), this.timeZone);

    const [today, currentRide, pendingRequests, vehicle, earnedToday] = await Promise.all([
      this.rideModel
        .aggregate<{ count: number; gross: number }>([
          {
            $match: {
              driverId: driver._id,
              status: RideStatus.COMPLETED,
              completedAt: { $gte: since },
            },
          },
          { $group: { _id: null, count: { $sum: 1 }, gross: { $sum: "$fare.finalFare" } } },
        ])
        .exec(),
      this.rideModel
        .findOne({ driverId: driver._id, status: { $in: DRIVER_ENGAGED_STATUSES } })
        .exec(),
      this.rideModel
        .countDocuments({ driverId: driver._id, status: RideStatus.DRIVER_ASSIGNED })
        .exec(),
      driver.activeVehicleId ? this.vehicleModel.findById(driver.activeVehicleId).exec() : null,
      this.earnings.todayFor(driver._id),
    ]);

    return {
      ...(await this.toStatus(driver, vehicle)),
      driverCode: driver.driverCode,
      ratingAverage: driver.ratingAverage,
      ratingCount: driver.ratingCount ?? 0,
      totalRides: driver.totalRides,
      today: {
        completedRides: today[0]?.count ?? 0,
        grossFares: today[0]?.gross ?? 0,
        earnings: earnedToday.net,
        paidRides: earnedToday.rides,
        currency: "INR",
      },
      currentRide: currentRide ? await this.views.forDriver(currentRide, driver) : null,
      pendingRequests,
    };
  }

  private async goOnline(
    driverUserId: string,
    driver: DriverProfileDocument,
    dto: UpdateAvailabilityDto,
  ): Promise<DriverDutyStatus> {
    const user = await this.users.findById(driverUserId);
    if (user.status !== UserStatus.ACTIVE)
      throw apiForbidden("This account cannot go online", "USER_BLOCKED");

    const vehicle = await this.pickVehicle(driver, dto.vehicleId);
    const hasNewLocation = dto.latitude !== undefined && dto.longitude !== undefined;
    // Online without a usable position would be "online but never matched".
    if (!hasNewLocation && !this.isFresh(driver.locationUpdatedAt))
      throw apiBadRequest("Share your current location to go online", "DRIVER_LOCATION_REQUIRED");

    const now = new Date();
    const updated = await this.driverModel
      .findByIdAndUpdate(
        driver._id,
        {
          $set: {
            isOnline: true,
            // A driver still holding a ride (e.g. reconnecting mid-trip) stays busy.
            isAvailable: !driver.currentRideId,
            activeVehicleId: vehicle._id,
            activeVehicleType: vehicle.vehicleType,
            lastSeenAt: now,
            wentOnlineAt: driver.isOnline && driver.wentOnlineAt ? driver.wentOnlineAt : now,
            ...(hasNewLocation
              ? {
                  currentLocation: toGeoJsonPoint({ latitude: dto.latitude!, longitude: dto.longitude! }),
                  locationUpdatedAt: now,
                }
              : {}),
          },
        },
        { returnDocument: "after" },
      )
      .exec();
    if (hasNewLocation)
      this.locations.remember(driver._id.toString(), { latitude: dto.latitude!, longitude: dto.longitude! });
    // A newly available driver may be exactly who a waiting customer needs.
    if (updated?.isAvailable) this.dispatch.kick();
    return this.toStatus(updated ?? driver, vehicle);
  }

  private async goOffline(driverUserId: string, driver: DriverProfileDocument): Promise<DriverDutyStatus> {
    if (driver.currentRideId) {
      const ride = await this.rideModel.findById(driver.currentRideId).exec();
      if (ride && DRIVER_ENGAGED_STATUSES.includes(ride.status))
        throw new ApiException(
          HttpStatus.CONFLICT,
          "Finish or cancel your current ride before going offline",
          "DRIVER_HAS_ACTIVE_RIDE",
          { rideId: ride._id.toString() },
        );
      if (ride?.status === RideStatus.DRIVER_ASSIGNED)
        // An unanswered request goes straight to the next driver.
        await this.dispatch.endAssignment(ride._id, driver._id, "DRIVER_OFFLINE", {
          type: RideActorType.DRIVER,
          userId: new Types.ObjectId(driverUserId),
        });
    }

    const updated = await this.driverModel
      .findByIdAndUpdate(
        driver._id,
        { $set: { isOnline: false, isAvailable: false }, $unset: { wentOnlineAt: 1 } },
        { returnDocument: "after" },
      )
      .exec();
    // Heal a pointer to a ride that has already finished (defensive; normal
    // flows always release through MatchingService).
    if (updated?.currentRideId && !(await this.rideModel.exists({ _id: updated.currentRideId, isActive: true }))) {
      await this.driverModel
        .updateOne({ _id: driver._id, currentRideId: updated.currentRideId }, { $unset: { currentRideId: 1 } })
        .exec();
      updated.currentRideId = undefined;
    }
    this.locations.forget(driver._id.toString());
    return this.toStatus(updated ?? driver);
  }

  private isFresh(updatedAt?: Date): boolean {
    return updatedAt !== undefined && Date.now() - updatedAt.getTime() <= this.locations.freshnessWindowMs;
  }

  private locationRejected(reason: LocationRejection): ApiException {
    switch (reason) {
      case "DRIVER_OFFLINE":
        return new ApiException(HttpStatus.CONFLICT, "Go online to share your location", "DRIVER_OFFLINE");
      case "RIDE_MISMATCH":
        return new ApiException(HttpStatus.CONFLICT, "That ride is not assigned to you", "RIDE_STATE_CONFLICT");
      case "DRIVER_NOT_APPROVED":
        return new ApiException(HttpStatus.FORBIDDEN, "Your driver account is not approved", "DRIVER_NOT_APPROVED");
      case "DRIVER_NOT_FOUND":
        return new ApiException(HttpStatus.NOT_FOUND, "Driver profile not found", "DRIVER_NOT_FOUND");
      default:
        return new ApiException(
          HttpStatus.UNPROCESSABLE_ENTITY,
          reason === "LOW_ACCURACY" ? "GPS accuracy is too low" : "This location is too old to use",
          "DRIVER_LOCATION_REQUIRED",
          { reason },
        );
    }
  }

  private async pickVehicle(driver: DriverProfileDocument, vehicleId?: string): Promise<VehicleDocument> {
    const filter = vehicleId
      ? { _id: new Types.ObjectId(vehicleId), driverId: driver._id, isActive: true }
      : { driverId: driver._id, isActive: true };
    const vehicle = await this.vehicleModel.findOne(filter).sort({ updatedAt: -1 }).exec();
    if (!vehicle)
      throw apiBadRequest(
        vehicleId ? "That vehicle is not active on your account" : "Add an active vehicle before going online",
        "DRIVER_NO_ACTIVE_VEHICLE",
      );
    return vehicle;
  }

  private async toStatus(driver: DriverProfileDocument, knownVehicle?: VehicleDocument | null): Promise<DriverDutyStatus> {
    const vehicle =
      knownVehicle ??
      (driver.activeVehicleId ? await this.vehicleModel.findById(driver.activeVehicleId).exec() : null);
    return {
      isOnline: driver.isOnline,
      isAvailable: driver.isAvailable,
      location: driver.currentLocation
        ? { ...fromGeoJsonPoint(driver.currentLocation), updatedAt: driver.locationUpdatedAt }
        : undefined,
      locationFresh: this.isFresh(driver.locationUpdatedAt),
      vehicle: vehicle
        ? {
            id: vehicle._id.toString(),
            vehicleType: vehicle.vehicleType,
            registrationNumber: vehicle.registrationNumber,
            make: vehicle.make,
            model: vehicle.vehicleModel,
          }
        : undefined,
      currentRideId: driver.currentRideId?.toString(),
      wentOnlineAt: driver.wentOnlineAt,
    };
  }
}
