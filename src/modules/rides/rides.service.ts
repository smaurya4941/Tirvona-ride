import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectModel } from "@nestjs/mongoose";
import type { Model, QueryFilter } from "mongoose";
import { Types } from "mongoose";
import { ApiException, apiBadRequest, apiForbidden } from "../../common/exceptions/api.exception";
import { UserRole } from "../../common/types/user-role.enum";
import type { AuthenticatedUser } from "../../common/types/jwt-payload";
import { DriversService } from "../drivers/drivers.service";
import { DriverStatus } from "../drivers/schemas/driver-profile.schema";
import type { DriverProfileDocument } from "../drivers/schemas/driver-profile.schema";
import { PlatformSettingsService } from "../ride-config/platform-settings.service";
import { TripPolicyService } from "../ride-config/trip-policy.service";
import type { GeoCoordinates } from "../locations/geo";
import type { RouteEstimate } from "../locations/route-estimator";
import { MatchingService } from "../matching/matching.service";
import { PricingService } from "../pricing/pricing.service";
import type { AppliedPeak } from "../pricing/peak-pricing";
import type { PricedFare } from "../pricing/pricing.service";
import { RideTypesService } from "../ride-types/ride-types.service";
import type { RideTypeDocument } from "../ride-types/schemas/ride-type.schema";
import type { VehicleType } from "../vehicles/schemas/vehicle.schema";
import { UserStatus } from "../users/schemas/user.schema";
import { UsersService } from "../users/users.service";
import type { CreateRideDto, RideRequestDto, TripDto } from "./dto/ride-requests.dto";
import { PromotionsService } from "../promotions/promotions.service";
import type { AppliedPromo } from "../promotions/promotions.service";
import { ZonesService } from "../zones/zones.service";
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
  /** Road path (Google encoded polyline); absent for straight-line estimates. */
  routePolyline?: string;
  fare: {
    currency: string;
    baseFare: number;
    /** What the trip is charged per km: the base rate, or the peak rate while `peak` is set. */
    perKmRate: number;
    basePerKmRate: number;
    /** Set while a peak-hour slot raises the per-km rate (the server decides; apps only show it). */
    peak?: AppliedPeak;
    perMinuteRate: number;
    minimumFare: number;
    distanceCharge: number;
    timeCharge: number;
    subtotal: number;
    minimumFareApplied: boolean;
    estimatedFare: number;
  };
  pricingVersion: number;
  /**
   * How long the nearest free driver of this ride type's vehicle would take
   * to reach the pickup (straight line, road-adjusted); null when none is
   * within the matching radius right now. Advisory only — booking still works
   * and dispatch keeps looking.
   */
  pickupEtaSeconds: number | null;
  /** Free drivers of this vehicle type within the matching radius. */
  driversNearby: number;
}

export interface Page<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
}

/** Free drivers of one vehicle type near a pickup. */
type DriverSupply = Map<VehicleType, { count: number; nearestMeters: number }>;
/** Enough to cover every vehicle type in a busy area. */
const SUPPLY_SCAN_LIMIT = 60;
/** Straight line → road distance, typical for Indian city grids. */
const ROAD_DETOUR_FACTOR = 1.3;
const MIN_PICKUP_ETA_SECONDS = 60;

const isDuplicateKey = (error: unknown, index?: string): boolean => {
  const mongoError = error as { code?: number; message?: string } | undefined;
  return mongoError?.code === 11000 && (!index || (mongoError.message ?? "").includes(index));
};

@Injectable()
export class RidesService {
  private readonly logger = new Logger(RidesService.name);
  private readonly searchTimeoutMs: number;
  private readonly averageSpeedMps: number;

  constructor(
    @InjectModel(Ride.name) private readonly rideModel: Model<Ride>,
    private readonly rideTypes: RideTypesService,
    private readonly pricing: PricingService,
    private readonly users: UsersService,
    private readonly drivers: DriversService,
    private readonly matching: MatchingService,
    private readonly dispatch: RideDispatchService,
    private readonly transitions: RideTransitionService,
    private readonly views: RideViewService,
    private readonly events: RideEventsService,
    private readonly zones: ZonesService,
    private readonly promotions: PromotionsService,
    private readonly tripPolicy: TripPolicyService,
    private readonly platformSettings: PlatformSettingsService,
    config: ConfigService,
  ) {
    this.searchTimeoutMs = config.getOrThrow<number>("rideSearchTimeoutSeconds") * 1000;
    this.averageSpeedMps = (config.getOrThrow<number>("routeAverageSpeedKmph") * 1000) / 3600;
  }

  // ── Estimates ─────────────────────────────────────────────────────────

  async estimate(dto: RideRequestDto): Promise<FareEstimateView> {
    await this.zones.assertServiceable(dto.pickup);
    const rideType = await this.rideTypes.getBookable(dto.rideType);
    // The ride type's current admin-set distance limits are judged first (400 short/long).
    const [{ route }, supply] = await Promise.all([
      this.tripPolicy.estimateTrip(rideType.code, dto.pickup, dto.destination),
      this.driverSupply(dto.pickup),
    ]);
    const fare = await this.pricing.priceTrip(rideType.code, route.distanceMeters, route.durationSeconds);
    return this.toEstimate(rideType, route, fare, supply);
  }

  /** One route calculation, priced for every bookable ride type. */
  async estimateAll(dto: TripDto): Promise<FareEstimateView[]> {
    await this.zones.assertServiceable(dto.pickup);
    const [rideTypes, supply] = await Promise.all([this.rideTypes.listActive(), this.driverSupply(dto.pickup)]);
    // Each ride type is judged by its own distance limits; the route is fetched once.
    const outcomes = await this.tripPolicy.estimateTripForAll(
      rideTypes.map((rideType) => rideType.code),
      dto.pickup,
      dto.destination,
    );
    const trips = new Map(outcomes.map((outcome) => [outcome.ok ? outcome.policy.rideType : outcome.rideType, outcome]));
    const estimates = await Promise.all(
      rideTypes.map(async (rideType) => {
        const outcome = trips.get(rideType.code);
        if (!outcome?.ok) return null;
        const { route } = outcome;
        try {
          const fare = await this.pricing.priceTrip(rideType.code, route.distanceMeters, route.durationSeconds);
          return this.toEstimate(rideType, route, fare, supply);
        } catch (error) {
          // A ride type without a tariff is hidden rather than failing the list.
          this.logger.warn(`Skipping ${rideType.code} estimate: ${(error as Error).message}`);
          return null;
        }
      }),
    );
    const quoted = estimates.filter((estimate): estimate is FareEstimateView => estimate !== null);
    // Nothing fits (too short / too long for every ride type, or no limits on file): say why.
    if (quoted.length === 0) {
      const failure = outcomes.find((outcome) => !outcome.ok);
      if (failure && !failure.ok) throw failure.error;
    }
    return quoted;
  }

  // ── Booking ───────────────────────────────────────────────────────────

  async create(customerUserId: string, dto: CreateRideDto): Promise<CustomerRideView> {
    const customerId = new Types.ObjectId(customerUserId);
    const customer = await this.users.findById(customerUserId);
    if (customer.status !== UserStatus.ACTIVE)
      throw apiForbidden("This account cannot book rides", "USER_BLOCKED");

    await this.assertNoActiveRide(customerId);

    // Re-price from scratch: whatever estimate the app showed is advisory.
    const rideType = await this.rideTypes.getBookable(dto.rideType);
    // Distance limits are re-read and re-checked now: an earlier estimate proves nothing.
    const { route, policy } = await this.tripPolicy.estimateTrip(rideType.code, dto.pickup, dto.destination);
    const fare = await this.pricing.priceTrip(rideType.code, route.distanceMeters, route.durationSeconds);
    // Service availability: once zones are defined, pickups must lie in one.
    const zone = await this.zones.assertServiceable(dto.pickup);

    // The promo is validated against the server price and one use reserved
    // for this ride id before the ride exists; released again if the insert
    // fails, and redeemed/released by the ride outcome afterwards.
    const rideId = new Types.ObjectId();
    let promo: AppliedPromo | undefined;
    if (dto.promoCode)
      promo = await this.promotions.reserve({
        userId: customerUserId,
        code: dto.promoCode,
        rideId,
        rideType: rideType.code,
        fare: fare.total,
      });

    let ride: RideDocument;
    try {
      ride = await this.insertRide({
        _id: rideId,
        customerId,
        rideType: rideType.code,
        vehicleType: rideType.vehicleType,
        pickup: dto.pickup,
        destination: dto.destination,
        distanceMeters: route.distanceMeters,
        durationSeconds: route.durationSeconds,
        distancePolicy: policy,
        routeProvider: route.provider,
        ...(route.polyline ? { routePolyline: route.polyline } : {}),
        fare: {
          currency: fare.currency,
          baseFare: fare.baseFare,
          perKmRate: fare.perKmRate,
          basePerKmRate: fare.basePerKmRate,
          ...(fare.peak ? { peak: fare.peak } : {}),
          perMinuteRate: fare.perMinuteRate,
          minimumFare: fare.minimumFare,
          distanceCharge: fare.distanceCharge,
          timeCharge: fare.timeCharge,
          subtotal: fare.subtotal,
          minimumFareApplied: fare.minimumFareApplied,
          estimatedFare: fare.total,
          pricingVersion: fare.pricingVersion,
          ...(promo ? { discount: promo.estimatedDiscount, payableFare: fare.total - promo.estimatedDiscount } : {}),
        },
        ...(promo
          ? {
              promo: {
                promoId: promo.promoId,
                code: promo.code,
                title: promo.title,
                discountType: promo.discountType,
                discountValue: promo.discountValue,
                maxDiscount: promo.maxDiscount,
                estimatedDiscount: promo.estimatedDiscount,
              },
            }
          : {}),
        ...(zone ? { zoneId: zone.zoneId, zoneName: zone.zoneName } : {}),
        status: RideStatus.SEARCHING,
        isActive: true,
        requestedAt: new Date(),
        searchExpiresAt: new Date(Date.now() + this.searchTimeoutMs),
      });
    } catch (error) {
      if (promo) await this.promotions.release(rideId);
      throw error;
    }
    await this.transitions.record({
      rideId: ride._id,
      toStatus: RideStatus.SEARCHING,
      actor: { type: RideActorType.CUSTOMER, userId: customerId },
      reason: "RIDE_REQUESTED",
      metadata: {
        estimatedFare: fare.total,
        pricingVersion: fare.pricingVersion,
        ...(fare.peak ? { peakSlot: fare.peak.name, peakHikePercent: fare.peak.hikePercent } : {}),
        ...(promo ? { promoCode: promo.code, discount: promo.estimatedDiscount } : {}),
        ...(zone ? { zone: zone.zoneName } : {}),
      },
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
    query: { page: number; limit: number; status?: RideStatus; startDate?: string; endDate?: string },
  ): Promise<Page<RideView>> {
    const start = query.startDate ? new Date(query.startDate) : undefined;
    const end = query.endDate ? new Date(query.endDate) : undefined;
    if (start && end && start.getTime() >= end.getTime()) {
      throw apiBadRequest("startDate must be before endDate", "RIDE_HISTORY_RANGE_INVALID");
    }

    let filter: QueryFilter<Ride>;
    if (user.role === UserRole.DRIVER) {
      const driver = await this.resolveDriver(user.userId);
      // Only rides the driver actually took on — not ones they were merely offered.
      filter = { driverId: driver._id, acceptedAt: { $exists: true } };
    } else {
      filter = { customerId: new Types.ObjectId(user.userId) };
    }
    if (query.status) filter = { ...filter, status: query.status };
    if (start || end) {
      filter = { ...filter, requestedAt: { ...(start && { $gte: start }), ...(end && { $lt: end }) } };
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

  /** A customer may have one active ride at a time, normal or circuit. */
  async assertNoActiveRide(customerId: Types.ObjectId): Promise<void> {
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

  /** Inserts a ride with a fresh code; the partial unique indexes are the real one-active-ride guard. */
  async insertRide(fields: Partial<Ride> & { _id?: Types.ObjectId }): Promise<RideDocument> {
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

  /**
   * Free drivers around the pickup, per vehicle type: how many, and how far
   * the nearest is. One geo query for every ride type on the quote. Supply
   * is decoration on a quote, so a failure here never fails the estimate.
   */
  private async driverSupply(pickup: GeoCoordinates): Promise<DriverSupply> {
    const supply: DriverSupply = new Map();
    try {
      const drivers = await this.matching.nearbyAvailable(pickup, await this.platformSettings.matchingRadiusMeters(), SUPPLY_SCAN_LIMIT);
      for (const driver of drivers) {
        if (!driver.vehicleType) continue;
        const entry = supply.get(driver.vehicleType);
        // Sorted nearest first by $geoNear: the first seen is the nearest.
        if (entry) entry.count += 1;
        else supply.set(driver.vehicleType, { count: 1, nearestMeters: driver.distanceMeters });
      }
    } catch (error) {
      this.logger.warn(`Driver supply lookup failed: ${(error as Error).message}`);
    }
    return supply;
  }

  /** Advisory only (never blocks a booking): how soon the nearest free driver of this vehicle type could arrive. */
  async pickupSupply(
    pickup: GeoCoordinates,
    vehicleType: VehicleType,
  ): Promise<{ pickupEtaSeconds: number | null; driversNearby: number }> {
    const available = (await this.driverSupply(pickup)).get(vehicleType);
    return {
      pickupEtaSeconds: available ? this.pickupEtaSeconds(available.nearestMeters) : null,
      driversNearby: available?.count ?? 0,
    };
  }

  private pickupEtaSeconds(nearestMeters: number): number {
    const seconds = (nearestMeters * ROAD_DETOUR_FACTOR) / this.averageSpeedMps;
    // Never promise less than a minute: the driver still has to accept.
    return Math.max(MIN_PICKUP_ETA_SECONDS, Math.round(seconds / 60) * 60);
  }

  private toEstimate(rideType: RideTypeDocument, route: RouteEstimate, fare: PricedFare, supply: DriverSupply): FareEstimateView {
    const available = supply.get(rideType.vehicleType);
    return {
      rideType: rideType.code,
      displayName: rideType.displayName,
      description: rideType.description,
      icon: rideType.icon,
      seatCapacity: rideType.seatCapacity,
      distanceMeters: route.distanceMeters,
      durationSeconds: route.durationSeconds,
      routeProvider: route.provider,
      routePolyline: route.polyline,
      fare: {
        currency: fare.currency,
        baseFare: fare.baseFare,
        perKmRate: fare.perKmRate,
        basePerKmRate: fare.basePerKmRate,
        peak: fare.peak,
        perMinuteRate: fare.perMinuteRate,
        minimumFare: fare.minimumFare,
        distanceCharge: fare.distanceCharge,
        timeCharge: fare.timeCharge,
        subtotal: fare.subtotal,
        minimumFareApplied: fare.minimumFareApplied,
        estimatedFare: fare.total,
      },
      pricingVersion: fare.pricingVersion,
      pickupEtaSeconds: available ? this.pickupEtaSeconds(available.nearestMeters) : null,
      driversNearby: available?.count ?? 0,
    };
  }
}
