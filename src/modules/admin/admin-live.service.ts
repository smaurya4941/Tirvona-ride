import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectModel } from "@nestjs/mongoose";
import type { Model, Types } from "mongoose";
import { apiNotFound } from "../../common/exceptions/api.exception";
import { DriverProfile, DriverStatus } from "../drivers/schemas/driver-profile.schema";
import { DriverLocationService } from "../locations/driver-location.service";
import { Ride } from "../rides/schemas/ride.schema";
import { User } from "../users/schemas/user.schema";
import { Vehicle } from "../vehicles/schemas/vehicle.schema";

export interface LiveDriverView {
  driverId: string;
  driverCode: string;
  name: string;
  phone: string;
  driverStatus: DriverStatus;
  isOnline: boolean;
  /** Online and free to take a ride (not on one). */
  isAvailable: boolean;
  vehicle?: { vehicleType: string; registrationNumber: string; make?: string; model?: string; color?: string };
  ride?: { rideId: string; rideCode: string; status: string };
  /** Absent when the driver has never shared a position. */
  location?: {
    latitude: number;
    longitude: number;
    heading?: number;
    speed?: number;
    updatedAt: Date;
    /** "live" = a fix the API holds in memory; "saved" = last stored position. */
    source: "live" | "saved";
    /** False once the position is older than the staleness window. */
    fresh: boolean;
  };
}

export interface LiveDriversReport {
  generatedAt: Date;
  /** Positions older than this are shown as stale. */
  staleAfterSeconds: number;
  /** True when more online drivers exist than were returned. */
  truncated: boolean;
  items: LiveDriverView[];
}

/** One screen never needs more pins than this; the report says when it cut off. */
const MAX_LIVE_DRIVERS = 1000;

const nameOf = (user?: { firstName?: string; lastName?: string } | null): string =>
  [user?.firstName, user?.lastName].filter(Boolean).join(" ");

type LeanProfile = DriverProfile & { _id: Types.ObjectId };

/**
 * Where the drivers are right now, for the admin live map and the driver
 * detail page. Read-only: positions come from the same live store and stored
 * last-known position the matching engine uses.
 */
@Injectable()
export class AdminLiveService {
  private readonly staleSeconds: number;

  constructor(
    @InjectModel(DriverProfile.name) private readonly driverModel: Model<DriverProfile>,
    @InjectModel(User.name) private readonly userModel: Model<User>,
    @InjectModel(Vehicle.name) private readonly vehicleModel: Model<Vehicle>,
    @InjectModel(Ride.name) private readonly rideModel: Model<Ride>,
    private readonly locations: DriverLocationService,
    config: ConfigService,
  ) {
    this.staleSeconds = config.getOrThrow<number>("driverLocationStaleSeconds");
  }

  /** Every approved driver who is online, with the best known position. */
  async onlineDrivers(): Promise<LiveDriversReport> {
    const filter = { driverStatus: DriverStatus.APPROVED, isOnline: true };
    const [profiles, total] = await Promise.all([
      this.driverModel.find(filter).sort({ locationUpdatedAt: -1 }).limit(MAX_LIVE_DRIVERS).lean().exec(),
      this.driverModel.countDocuments(filter).exec(),
    ]);
    return {
      generatedAt: new Date(),
      staleAfterSeconds: this.staleSeconds,
      truncated: total > profiles.length,
      items: await this.toViews(profiles as LeanProfile[]),
    };
  }

  /** One driver, whatever their status — the position may be missing or old. */
  async driver(driverId: string): Promise<LiveDriverView> {
    const profile = await this.driverModel.findById(driverId).lean().exec();
    if (!profile) throw apiNotFound("Driver not found", "DRIVER_NOT_FOUND");
    const [view] = await this.toViews([profile as LeanProfile]);
    return view;
  }

  private async toViews(profiles: LeanProfile[]): Promise<LiveDriverView[]> {
    if (!profiles.length) return [];
    const rideIds = profiles.flatMap((profile) => (profile.currentRideId ? [profile.currentRideId] : []));
    const [users, vehicles, rides] = await Promise.all([
      this.userModel
        .find({ _id: { $in: profiles.map((profile) => profile.userId) } })
        .select("firstName lastName phone")
        .lean()
        .exec(),
      this.vehicleModel
        .find({ driverId: { $in: profiles.map((profile) => profile._id) }, isActive: true })
        .select("driverId vehicleType registrationNumber make vehicleModel color")
        .lean()
        .exec(),
      rideIds.length
        ? this.rideModel
            .find({ _id: { $in: rideIds } })
            .select("rideCode status")
            .lean()
            .exec()
        : Promise.resolve([]),
    ]);
    const userById = new Map(users.map((user) => [user._id.toString(), user]));
    const vehicleByDriver = new Map(vehicles.map((vehicle) => [vehicle.driverId.toString(), vehicle]));
    const rideById = new Map(rides.map((ride) => [ride._id.toString(), ride]));

    return profiles.map((profile): LiveDriverView => {
      const id = profile._id.toString();
      const user = userById.get(profile.userId.toString());
      const vehicle = vehicleByDriver.get(id);
      const ride = profile.currentRideId ? rideById.get(profile.currentRideId.toString()) : undefined;
      return {
        driverId: id,
        driverCode: profile.driverCode,
        name: nameOf(user),
        phone: user?.phone ?? "",
        driverStatus: profile.driverStatus,
        isOnline: profile.isOnline,
        isAvailable: profile.isAvailable,
        vehicle: vehicle && {
          vehicleType: vehicle.vehicleType,
          registrationNumber: vehicle.registrationNumber,
          make: vehicle.make,
          model: vehicle.vehicleModel,
          color: vehicle.color,
        },
        ride: ride && { rideId: ride._id.toString(), rideCode: ride.rideCode, status: ride.status },
        location: this.locations.positionFor(id, profile),
      };
    });
  }
}
