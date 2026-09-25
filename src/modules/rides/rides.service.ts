import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectModel } from "@nestjs/mongoose";
import type { Model, QueryFilter } from "mongoose";
import { Types } from "mongoose";
import { ApiException, apiForbidden } from "../../common/exceptions/api.exception";
import { UserRole } from "../../common/types/user-role.enum";
import type { AuthenticatedUser } from "../../common/types/jwt-payload";
import { DriversService } from "../drivers/drivers.service";
import { DriverStatus } from "../drivers/schemas/driver-profile.schema";
import type { DriverProfileDocument } from "../drivers/schemas/driver-profile.schema";
import { LocationsService } from "../locations/locations.service";
import type { RouteEstimate } from "../locations/route-estimator";
import { MatchingService } from "../matching/matching.service";
import { PricingService } from "../pricing/pricing.service";
import type { PricedFare } from "../pricing/pricing.service";
import { RideTypesService } from "../ride-types/ride-types.service";
import type { RideTypeDocument } from "../ride-types/schemas/ride-type.schema";
import { UserStatus } from "../users/schemas/user.schema";
import { UsersService } from "../users/users.service";
import type { RideRequestDto, TripDto } from "./dto/ride-requests.dto";
import { generateRideCode } from "./ride-code";
import { RideDispatchService } from "./ride-dispatch.service";
import { RideEventsService } from "./ride-events.service";
import { rideNotFound } from "./ride-errors";
import { DRIVER_ENGAGED_STATUSES, RideActorType, RideStatus } from "./ride-state-machine";
import { RideTransitionService } from "./ride-transition.service";
import { RideViewService } from "./ride-view.service";
import type { CustomerRideView, DriverRideView, RideView } from "./ride-view.service";
import { Ride } from "./schemas/ride.schema";
import type { RideDocument } from "./schemas/ride.schema";

export interface FareEstimateView {
  rideType: string;
  displayName: string;
  description?: string;
  icon: string;
  seatCapacity: number;
  distanceMeters: number;
  durationSeconds: number;
  routeProvider: string;
  fare: {
    currency: string;
    baseFare: number;
    perKmRate: number;
    perMinuteRate: number;
    minimumFare: number;
    distanceCharge: number;
    timeCharge: number;
    subtotal: number;
    minimumFareApplied: boolean;
    estimatedFare: number;
  };
  pricingVersion: number;
}

export interface Page<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
}

const isDuplicateKey = (error: unknown, index?: string): boolean => {
  const mongoError = error as { code?: number; message?: string } | undefined;
  return mongoError?.code === 11000 && (!index || (mongoError.message ?? "").includes(index));
};

@Injectable()
export class RidesService {
  private readonly logger = new Logger(RidesService.name);
  private readonly searchTimeoutMs: number;

  constructor(
    @InjectModel(Ride.name) private readonly rideModel: Model<Ride>,
    private readonly rideTypes: RideTypesService,
    private readonly pricing: PricingService,
    private readonly locations: LocationsService,
    private readonly users: UsersService,
    private readonly drivers: DriversService,
    private readonly matching: MatchingService,
    private readonly dispatch: RideDispatchService,
    private readonly transitions: RideTransitionService,
    private readonly views: RideViewService,
    private readonly events: RideEventsService,
    config: ConfigService,
  ) {
    this.searchTimeoutMs = config.getOrThrow<number>("rideSearchTimeoutSeconds") * 1000;
  }

  // ── Estimates ─────────────────────────────────────────────────────────

  async estimate(dto: RideRequestDto): Promise<FareEstimateView> {
    const rideType = await this.rideTypes.getBookable(dto.rideType);
    const route = await this.locations.estimateTrip(dto.pickup, dto.destination);
    const fare = await this.pricing.priceTrip(rideType.code, route.distanceMeters, route.durationSeconds);
    return this.toEstimate(rideType, route, fare);
  }

  /** One route calculation, priced for every bookable ride type. */
  async estimateAll(dto: TripDto): Promise<FareEstimateView[]> {
    const route = await this.locations.estimateTrip(dto.pickup, dto.destination);
    const rideTypes = await this.rideTypes.listActive();
    const estimates = await Promise.all(
      rideTypes.map(async (rideType) => {
        try {
          const fare = await this.pricing.priceTrip(rideType.code, route.distanceMeters, route.durationSeconds);
          return this.toEstimate(rideType, route, fare);
        } catch (error) {
          // A ride type without a tariff is hidden rather than failing the list.
          this.logger.warn(`Skipping ${rideType.code} estimate: ${(error as Error).message}`);
          return null;
        }
      }),
    );
    return estimates.filter((estimate): estimate is FareEstimateView => estimate !== null);
  }

  // ── Booking ───────────────────────────────────────────────────────────

  async create(customerUserId: string, dto: RideRequestDto): Promise<CustomerRideView> {
    const customerId = new Types.ObjectId(customerUserId);
    const customer = await this.users.findById(customerUserId);
    if (customer.status !== UserStatus.ACTIVE)
      throw apiForbidden("This account cannot book rides", "USER_BLOCKED");

    await this.assertNoActiveRide(customerId);

    // Re-price from scratch: whatever estimate the app showed is advisory.
    const rideType = await this.rideTypes.getBookable(dto.rideType);
    const route = await this.locations.estimateTrip(dto.pickup, dto.destination);
    const fare = await this.pricing.priceTrip(rideType.code, route.distanceMeters, route.durationSeconds);

    const ride = await this.insertRide({
      customerId,
      rideType: rideType.code,
      vehicleType: rideType.vehicleType,
      pickup: dto.pickup,
      destination: dto.destination,
      distanceMeters: route.distanceMeters,
      durationSeconds: route.durationSeconds,
      routeProvider: route.provider,
      fare: {
        currency: fare.currency,
        baseFare: fare.baseFare,
        perKmRate: fare.perKmRate,
        perMinuteRate: fare.perMinuteRate,
        minimumFare: fare.minimumFare,
        distanceCharge: fare.distanceCharge,
        timeCharge: fare.timeCharge,
        subtotal: fare.subtotal,
        minimumFareApplied: fare.minimumFareApplied,
        estimatedFare: fare.total,
        pricingVersion: fare.pricingVersion,
      },
      status: RideStatus.SEARCHING,
      isActive: true,
      requestedAt: new Date(),
      searchExpiresAt: new Date(Date.now() + this.searchTimeoutMs),
    });
    await this.transitions.record({
      rideId: ride._id,
      toStatus: RideStatus.SEARCHING,
      actor: { type: RideActorType.CUSTOMER, userId: customerId },
      reason: "RIDE_REQUESTED",
      metadata: { estimatedFare: fare.total, pricingVersion: fare.pricingVersion },
    });
    this.events.created(ride);
    this.dispatch.scheduleDeadline(ride._id, "search", ride.searchExpiresAt);

    // First matching attempt inline so a nearby driver is usually assigned
    // before the booking response even returns. Failure here must not lose the
    // booking — the background sweep retries.
    let current: RideDocument = ride;
    try {
      current = (await this.dispatch.dispatch(ride._id)) ?? ride;
    } catch (error) {
      this.logger.error(
        `Initial dispatch failed for ride ${ride.rideCode}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
    return this.views.forCustomer(current);
  }

  // ── Reads ─────────────────────────────────────────────────────────────

  async getForUser(user: AuthenticatedUser, rideId: string): Promise<CustomerRideView | DriverRideView> {
    if (user.role === UserRole.DRIVER) {
      const driver = await this.resolveDriver(user.userId);
      const ride = await this.rideModel.findOne({ _id: rideId, driverId: driver._id }).exec();
      if (!ride) throw rideNotFound();
      await this.matching.touch(driver._id);
      return this.views.forDriver(await this.dispatch.settle(ride), driver);
    }

    const ride = await this.findCustomerRide(user.userId, { _id: new Types.ObjectId(rideId) });
    if (!ride) throw rideNotFound();
    return this.views.forCustomer(await this.settleWithOtp(ride));
  }

  /** The caller's in-flight ride, if any — used to resume after an app restart. */
  async getActive(user: AuthenticatedUser): Promise<CustomerRideView | DriverRideView | null> {
    if (user.role === UserRole.DRIVER) {
      const driver = await this.resolveDriver(user.userId);
      const ride = await this.rideModel
        .findOne({ driverId: driver._id, status: { $in: DRIVER_ENGAGED_STATUSES } })
        .exec();
      return ride ? this.views.forDriver(ride, driver) : null;
    }

    const ride = await this.findCustomerRide(user.userId, { isActive: true });
    if (!ride) return null;
    const settled = await this.settleWithOtp(ride);
    return this.views.forCustomer(settled);
  }

  async history(
    user: AuthenticatedUser,
    query: { page: number; limit: number; status?: RideStatus },
  ): Promise<Page<RideView>> {
    let filter: QueryFilter<Ride>;
    if (user.role === UserRole.DRIVER) {
      const driver = await this.resolveDriver(user.userId);
      // Only rides the driver actually took on — not ones they were merely offered.
      filter = { driverId: driver._id, acceptedAt: { $exists: true } };
    } else {
      filter = { customerId: new Types.ObjectId(user.userId) };
    }
    if (query.status) filter = { ...filter, status: query.status };

    const [rides, total] = await Promise.all([
      this.rideModel
        .find(filter)
        .sort({ requestedAt: -1, _id: -1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .exec(),
      this.rideModel.countDocuments(filter).exec(),
    ]);
    return {
      items: rides.map((ride) => this.views.base(ride)),
      page: query.page,
      limit: query.limit,
      total,
      hasMore: query.page * query.limit < total,
    };
  }

  /**
   * Offers currently assigned to this driver. Offers are pushed live as
   * `ride.requested`; the app calls this only to recover after a reconnect
   * or restart (REST is the source of current state).
   */
  async requestsForDriver(driverUserId: string): Promise<DriverRideView[]> {
    const driver = await this.resolveDriver(driverUserId);
    await this.matching.touch(driver._id);

    const rides = await this.rideModel
      .find({ driverId: driver._id, status: RideStatus.DRIVER_ASSIGNED })
      .exec();
    const views: DriverRideView[] = [];
    for (const ride of rides) {
      const settled = await this.dispatch.settle(ride);
      if (settled.status === RideStatus.DRIVER_ASSIGNED && settled.driverId?.equals(driver._id))
        views.push(await this.views.forDriver(settled, driver));
    }
    return views;
  }

  // ── Helpers shared with the lifecycle/availability services ──────────

  /** An authenticated DRIVER whose account is approved to take rides. */
  async resolveDriver(driverUserId: string): Promise<DriverProfileDocument> {
    const driver = await this.drivers.getByUserId(driverUserId);
    if (driver.driverStatus !== DriverStatus.APPROVED)
      throw apiForbidden("Your driver account is not approved to take rides", "DRIVER_NOT_APPROVED");
    return driver;
  }

  private async assertNoActiveRide(customerId: Types.ObjectId): Promise<void> {
    const active = await this.rideModel.findOne({ customerId, isActive: true }).select("_id status").exec();
    if (active) throw this.alreadyActive(active._id);
  }

  private alreadyActive(rideId?: Types.ObjectId): ApiException {
    return new ApiException(
      409,
      "You already have a ride in progress",
      "RIDE_ALREADY_ACTIVE",
      rideId ? { rideId: rideId.toString() } : undefined,
    );
  }

  private async insertRide(fields: Partial<Ride>): Promise<RideDocument> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.rideModel.create({ ...fields, rideCode: generateRideCode() });
      } catch (error) {
        // Lost a double-tap race: the partial unique index is the real guard.
        if (isDuplicateKey(error, "uniq_active_ride_per_customer")) {
          const active = await this.rideModel
            .findOne({ customerId: fields.customerId, isActive: true })
            .select("_id")
            .exec();
          throw this.alreadyActive(active?._id);
        }
        if (!isDuplicateKey(error, "rideCode")) throw error;
      }
    }
    throw new Error("Could not allocate a unique ride code");
  }

  private findCustomerRide(customerUserId: string, filter: QueryFilter<Ride>): Promise<RideDocument | null> {
    return this.rideModel
      .findOne({ ...filter, customerId: new Types.ObjectId(customerUserId) })
      .sort({ requestedAt: -1 })
      .select("+otpCode")
      .exec();
  }

  /** settle() re-reads without +otpCode; re-fetch when the OTP must be shown. */
  private async settleWithOtp(ride: RideDocument): Promise<RideDocument> {
    const settled = await this.dispatch.settle(ride);
    if (settled === ride || settled.status !== RideStatus.DRIVER_ARRIVED) return settled;
    return (await this.rideModel.findById(settled._id).select("+otpCode").exec()) ?? settled;
  }

  private toEstimate(rideType: RideTypeDocument, route: RouteEstimate, fare: PricedFare): FareEstimateView {
    return {
      rideType: rideType.code,
      displayName: rideType.displayName,
      description: rideType.description,
      icon: rideType.icon,
      seatCapacity: rideType.seatCapacity,
      distanceMeters: route.distanceMeters,
      durationSeconds: route.durationSeconds,
      routeProvider: route.provider,
      fare: {
        currency: fare.currency,
        baseFare: fare.baseFare,
        perKmRate: fare.perKmRate,
        perMinuteRate: fare.perMinuteRate,
        minimumFare: fare.minimumFare,
        distanceCharge: fare.distanceCharge,
        timeCharge: fare.timeCharge,
        subtotal: fare.subtotal,
        minimumFareApplied: fare.minimumFareApplied,
        estimatedFare: fare.total,
      },
      pricingVersion: fare.pricingVersion,
    };
  }
}
