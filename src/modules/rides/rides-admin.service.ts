import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectModel } from "@nestjs/mongoose";
import type { Model, QueryFilter } from "mongoose";
import { Types } from "mongoose";
import { startOfDayInTimeZone } from "../../common/utils/time";
import { DriverProfile } from "../drivers/schemas/driver-profile.schema";
import { DriverLocationService } from "../locations/driver-location.service";
import type { CheckpointKind, CheckpointSource } from "../locations/schemas/driver-location-checkpoint.schema";
import { MatchingService } from "../matching/matching.service";
import type { RideTypeCode } from "../ride-types/schemas/ride-type.schema";
import { User } from "../users/schemas/user.schema";
import { RideDispatchService } from "./ride-dispatch.service";
import { rideConflict, rideNotFound } from "./ride-errors";
import {
  CUSTOMER_CANCELLABLE_STATUSES,
  DRIVER_ENGAGED_STATUSES,
  RideActorType,
  RideStatus,
} from "./ride-state-machine";
import type { RideActorType as RideActorTypeValue } from "./ride-state-machine";
import { RideTransitionService } from "./ride-transition.service";
import { RideViewService } from "./ride-view.service";
import type { RideView } from "./ride-view.service";
import type { Page } from "./rides.service";
import { Ride } from "./schemas/ride.schema";
import type { RideVehicle } from "./schemas/ride.schema";

interface PersonRef {
  id: string;
  name: string;
  phone: string;
}

export interface AdminRideListItem extends RideView {
  customer: PersonRef | null;
  driver: (PersonRef & { driverId: string; driverCode: string }) | null;
}

export interface AdminRideDetail {
  ride: RideView & {
    pricingVersion: number;
    dispatchCount: number;
    rejectedDriverCount: number;
    driverDistanceMeters?: number;
    assignmentExpiresAt?: Date;
    searchExpiresAt: Date;
    otp: { issued: boolean; attempts: number; expiresAt?: Date; verifiedAt?: Date };
    vehicle?: Omit<RideVehicle, "vehicleId"> & { vehicleId?: string };
    createdAt: Date;
    updatedAt: Date;
  };
  customer: PersonRef | null;
  driver: (PersonRef & { driverId: string; driverCode: string; ratingAverage: number; totalRides: number }) | null;
  history: Array<{
    id: string;
    fromStatus?: RideStatus;
    toStatus: RideStatus;
    actorType: RideActorTypeValue;
    actorId?: string;
    actorName?: string;
    reason?: string;
    metadata?: Record<string, unknown>;
    createdAt: Date;
  }>;
  /** Coarse location checkpoints (lifecycle points + sparse trail), never every ping. */
  checkpoints: Array<{
    kind: CheckpointKind;
    latitude: number;
    longitude: number;
    source: CheckpointSource;
    recordedAt: Date;
  }>;
}

export interface AdminRideStats {
  activeRides: number;
  searching: number;
  inProgress: number;
  completedToday: number;
  cancelledToday: number;
  noDriverToday: number;
  driversOnline: number;
  driversAvailable: number;
  /** Online + available + a location fresh enough for matching. */
  driversMatchable: number;
}

export interface AdminRideListQuery {
  page: number;
  limit: number;
  status?: RideStatus;
  rideType?: RideTypeCode;
  search?: string;
}

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const nameOf = (user?: { firstName?: string; lastName?: string } | null): string =>
  [user?.firstName, user?.lastName].filter(Boolean).join(" ");

@Injectable()
export class RidesAdminService {
  private readonly timeZone: string;

  constructor(
    @InjectModel(Ride.name) private readonly rideModel: Model<Ride>,
    @InjectModel(User.name) private readonly userModel: Model<User>,
    @InjectModel(DriverProfile.name) private readonly driverModel: Model<DriverProfile>,
    private readonly transitions: RideTransitionService,
    private readonly matching: MatchingService,
    private readonly views: RideViewService,
    private readonly locations: DriverLocationService,
    private readonly dispatch: RideDispatchService,
    config: ConfigService,
  ) {
    this.timeZone = config.getOrThrow<string>("appTimeZone");
  }

  async list(query: AdminRideListQuery): Promise<Page<AdminRideListItem>> {
    const filter: QueryFilter<Ride> = {};
    if (query.status) filter.status = query.status;
    if (query.rideType) filter.rideType = query.rideType;
    if (query.search) {
      const term = query.search.trim();
      if (Types.ObjectId.isValid(term) && /^[0-9a-f]{24}$/i.test(term)) filter._id = new Types.ObjectId(term);
      else {
        // Ride code prefix, or the customer's phone.
        const customers = await this.userModel
          .find({ phone: { $regex: escapeRegex(term) } })
          .select("_id")
          .limit(50)
          .lean()
          .exec();
        filter.$or = [
          { rideCode: { $regex: `^${escapeRegex(term.toUpperCase())}` } },
          { customerId: { $in: customers.map((customer) => customer._id) } },
        ];
      }
    }

    const [rides, total] = await Promise.all([
      this.rideModel
        .find(filter)
        .sort({ requestedAt: -1, _id: -1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .exec(),
      this.rideModel.countDocuments(filter).exec(),
    ]);

    // Two batched lookups instead of 2 × N.
    const users = await this.userModel
      .find({
        _id: {
          $in: [
            ...rides.map((ride) => ride.customerId),
            ...rides.flatMap((ride) => (ride.driverUserId ? [ride.driverUserId] : [])),
          ],
        },
      })
      .select("firstName lastName phone")
      .lean()
      .exec();
    const drivers = await this.driverModel
      .find({ _id: { $in: rides.flatMap((ride) => (ride.driverId ? [ride.driverId] : [])) } })
      .select("driverCode userId")
      .lean()
      .exec();
    const userById = new Map(users.map((user) => [user._id.toString(), user]));
    const driverById = new Map(drivers.map((driver) => [driver._id.toString(), driver]));

    return {
      items: rides.map((ride) => {
        const customer = userById.get(ride.customerId.toString());
        const driverProfile = ride.driverId ? driverById.get(ride.driverId.toString()) : undefined;
        const driverUser = driverProfile ? userById.get(driverProfile.userId.toString()) : undefined;
        return {
          ...this.views.base(ride),
          customer: customer
            ? { id: customer._id.toString(), name: nameOf(customer), phone: customer.phone }
            : null,
          driver:
            driverProfile && driverUser
              ? {
                  id: driverUser._id.toString(),
                  driverId: driverProfile._id.toString(),
                  driverCode: driverProfile.driverCode,
                  name: nameOf(driverUser),
                  phone: driverUser.phone,
                }
              : null,
        };
      }),
      page: query.page,
      limit: query.limit,
      total,
      hasMore: query.page * query.limit < total,
    };
  }

  async detail(rideId: string): Promise<AdminRideDetail> {
    const ride = await this.rideModel.findById(rideId).exec();
    if (!ride) throw rideNotFound();

    const [history, customer, driverProfile, checkpoints] = await Promise.all([
      this.transitions.history(ride._id),
      this.userModel.findById(ride.customerId).select("firstName lastName phone").lean().exec(),
      ride.driverId ? this.driverModel.findById(ride.driverId).lean().exec() : null,
      this.locations.checkpoints(ride._id),
    ]);
    const driverUser = driverProfile
      ? await this.userModel.findById(driverProfile.userId).select("firstName lastName phone").lean().exec()
      : null;

    const actorIds = [
      ...new Set(history.flatMap((entry) => (entry.actorId ? [entry.actorId.toString()] : []))),
    ];
    const actors = await this.userModel
      .find({ _id: { $in: actorIds.map((id) => new Types.ObjectId(id)) } })
      .select("firstName lastName")
      .lean()
      .exec();
    const actorName = new Map(actors.map((actor) => [actor._id.toString(), nameOf(actor)]));

    return {
      ride: {
        ...this.views.base(ride),
        searchExpiresAt: ride.searchExpiresAt,
        assignmentExpiresAt: ride.assignmentExpiresAt,
        pricingVersion: ride.fare.pricingVersion,
        dispatchCount: ride.dispatchCount,
        rejectedDriverCount: ride.rejectedDriverIds.length,
        driverDistanceMeters: ride.driverDistanceMeters,
        // Never the code itself — support has no reason to see it.
        otp: {
          issued: Boolean(ride.arrivedAt),
          attempts: ride.otpAttempts,
          expiresAt: ride.otpExpiresAt,
          verifiedAt: ride.otpVerifiedAt,
        },
        vehicle: ride.vehicle
          ? {
              vehicleId: ride.vehicle.vehicleId?.toString(),
              vehicleType: ride.vehicle.vehicleType,
              registrationNumber: ride.vehicle.registrationNumber,
              make: ride.vehicle.make,
              model: ride.vehicle.model,
              color: ride.vehicle.color,
            }
          : undefined,
        createdAt: ride.get("createdAt") as Date,
        updatedAt: ride.get("updatedAt") as Date,
      },
      customer: customer
        ? { id: customer._id.toString(), name: nameOf(customer), phone: customer.phone }
        : null,
      driver:
        driverProfile && driverUser
          ? {
              id: driverUser._id.toString(),
              driverId: driverProfile._id.toString(),
              driverCode: driverProfile.driverCode,
              name: nameOf(driverUser),
              phone: driverUser.phone,
              ratingAverage: driverProfile.ratingAverage,
              totalRides: driverProfile.totalRides,
            }
          : null,
      history: history.map((entry) => ({
        id: entry._id.toString(),
        fromStatus: entry.fromStatus,
        toStatus: entry.toStatus,
        actorType: entry.actorType,
        actorId: entry.actorId?.toString(),
        actorName: entry.actorId ? actorName.get(entry.actorId.toString()) : undefined,
        reason: entry.reason,
        metadata: entry.metadata,
        createdAt: entry.get("createdAt") as Date,
      })),
      checkpoints,
    };
  }

  /** Ops escape hatch for a stuck ride; same rules as a customer cancel. */
  async cancel(rideId: string, adminUserId: string, reason: string): Promise<AdminRideDetail> {
    const ride = await this.rideModel.findById(rideId).exec();
    if (!ride) throw rideNotFound();
    if (!CUSTOMER_CANCELLABLE_STATUSES.includes(ride.status))
      throw rideConflict(
        `A ride that is ${ride.status.toLowerCase().replace(/_/g, " ")} cannot be cancelled`,
        ride.status,
        "RIDE_NOT_CANCELLABLE",
      );

    const adminId = new Types.ObjectId(adminUserId);
    const cancelled = await this.transitions.apply({
      rideId: ride._id,
      from: ride.status,
      to: RideStatus.CANCELLED,
      set: {
        cancelledAt: new Date(),
        cancellation: { cancelledBy: RideActorType.ADMIN, cancelledByUserId: adminId, reason },
      },
      unset: ["otpCode", "otpExpiresAt", "assignmentExpiresAt"],
      actor: { type: RideActorType.ADMIN, userId: adminId },
      reason,
    });
    if (!cancelled)
      throw rideConflict("The ride changed while cancelling. Reload and retry.", ride.status, "RIDE_STATE_CONFLICT");
    if (ride.driverId) {
      await this.matching.release(ride.driverId, ride._id);
      this.dispatch.kick();
    }
    return this.detail(rideId);
  }

  async stats(): Promise<AdminRideStats> {
    const since = startOfDayInTimeZone(new Date(), this.timeZone);
    const [byStatus, completedToday, cancelledToday, noDriverToday, driversOnline, driversAvailable, driversMatchable] =
      await Promise.all([
        this.rideModel
          .aggregate<{ _id: RideStatus; count: number }>([
            { $match: { isActive: true } },
            { $group: { _id: "$status", count: { $sum: 1 } } },
          ])
          .exec(),
        this.rideModel.countDocuments({ status: RideStatus.COMPLETED, completedAt: { $gte: since } }).exec(),
        this.rideModel.countDocuments({ status: RideStatus.CANCELLED, cancelledAt: { $gte: since } }).exec(),
        this.rideModel
          .countDocuments({ status: RideStatus.NO_DRIVER_AVAILABLE, expiredAt: { $gte: since } })
          .exec(),
        this.driverModel.countDocuments({ isOnline: true }).exec(),
        this.driverModel.countDocuments({ isOnline: true, isAvailable: true }).exec(),
        this.driverModel
          .countDocuments({
            isOnline: true,
            isAvailable: true,
            locationUpdatedAt: { $gte: new Date(Date.now() - this.locations.freshnessWindowMs) },
          })
          .exec(),
      ]);
    const count = (statuses: readonly RideStatus[]): number =>
      byStatus.filter((entry) => statuses.includes(entry._id)).reduce((sum, entry) => sum + entry.count, 0);

    return {
      activeRides: byStatus.reduce((sum, entry) => sum + entry.count, 0),
      searching: count([RideStatus.SEARCHING, RideStatus.DRIVER_ASSIGNED]),
      inProgress: count(DRIVER_ENGAGED_STATUSES),
      completedToday,
      cancelledToday,
      noDriverToday,
      driversOnline,
      driversAvailable,
      driversMatchable,
    };
  }
}
