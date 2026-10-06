import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectModel } from "@nestjs/mongoose";
import type { Model } from "mongoose";
import { Types } from "mongoose";
import { apiBadRequest, apiForbidden } from "../../common/exceptions/api.exception";
import { CircuitPackagesService } from "../circuit-packages/circuit-packages.service";
import type { CircuitStopView } from "../circuit-packages/circuit-packages.service";
import type { CircuitPackageDocument } from "../circuit-packages/schemas/circuit-package.schema";
import { haversineMeters } from "../locations/geo";
import { LocationsService } from "../locations/locations.service";
import { joinLegs } from "../locations/polyline";
import { RideDispatchService } from "../rides/ride-dispatch.service";
import { RideEventsService } from "../rides/ride-events.service";
import { RideActorType, RideStatus } from "../rides/ride-state-machine";
import { RideTransitionService } from "../rides/ride-transition.service";
import { RideViewService } from "../rides/ride-view.service";
import type { CustomerRideView } from "../rides/ride-view.service";
import { RidesService } from "../rides/rides.service";
import { Ride } from "../rides/schemas/ride.schema";
import { RideTypesService } from "../ride-types/ride-types.service";
import { UserStatus } from "../users/schemas/user.schema";
import { UsersService } from "../users/users.service";
import { ZonesService } from "../zones/zones.service";
import { CircuitLedgerService } from "./circuit-ledger.service";
import { calculateCircuitFare } from "./circuit-pricing";
import { CircuitStopStatus, RideKind } from "./circuit-ride.types";
import type { CircuitEstimateDto, CreateCircuitRideDto } from "./dto/circuit-ride.dto";

export interface CircuitEstimateView {
  package: { id: string; code: string; name: string; city: string; coverPath: string | null; revision: number };
  rideType: { code: string; displayName: string; icon: string; seatCapacity: number };
  passengers: number;
  /** The most passengers this vehicle may carry on this circuit. */
  maxPassengers: number;
  pickup: { address: string; latitude: number; longitude: number };
  stops: CircuitStopView[];
  route: {
    /** Pickup → stop 1 → … → last stop. */
    distanceMeters: number;
    durationSeconds: number;
    provider: string;
    polyline?: string;
    pickupLeg: { distanceMeters: number; durationSeconds: number };
    legs: Array<{ from: string; to: string; distanceMeters: number; durationSeconds: number }>;
  };
  pricing: {
    basePrice: number;
    includedDistanceMeters: number;
    includedDurationSeconds: number;
    extraDistanceRatePerKm: number;
    extraDurationRatePerHour: number;
  };
  fare: {
    currency: string;
    /** The package price: what the circuit costs when it stays within the included distance and time. */
    packagePrice: number;
    /** Package price plus any extra the planned route already implies. Still an estimate: the final fare is set when the circuit ends. */
    estimatedTotal: number;
    expectedExtraDistanceCharge: number;
    expectedExtraDurationCharge: number;
    isFinal: false;
  };
  /** Set when the planned route alone already exceeds the included distance. */
  notices: string[];
  pickupEtaSeconds: number | null;
  driversNearby: number;
  cancellationPolicy?: string;
}

const isDuplicateKey = (error: unknown): boolean => (error as { code?: number } | undefined)?.code === 11000;

/**
 * Circuit estimate and booking. A circuit is booked like a ride and runs on the
 * same ride record — matching, OTP start, payments, earnings, ratings and SOS
 * are shared — so this service only adds what is specific to a package:
 * validating it, routing pickup → stops, pricing it, and freezing the package
 * into the ride so later admin edits never touch a booking.
 */
@Injectable()
export class CircuitRidesService {
  private readonly logger = new Logger(CircuitRidesService.name);
  private readonly maxPickupDistanceMeters: number;
  private readonly searchTimeoutMs: number;

  constructor(
    @InjectModel(Ride.name) private readonly rideModel: Model<Ride>,
    private readonly packages: CircuitPackagesService,
    private readonly rideTypes: RideTypesService,
    private readonly locations: LocationsService,
    private readonly zones: ZonesService,
    private readonly users: UsersService,
    private readonly rides: RidesService,
    private readonly dispatch: RideDispatchService,
    private readonly transitions: RideTransitionService,
    private readonly events: RideEventsService,
    private readonly views: RideViewService,
    private readonly ledger: CircuitLedgerService,
    config: ConfigService,
  ) {
    this.maxPickupDistanceMeters = config.getOrThrow<number>("circuitMaxPickupDistanceKm") * 1000;
    this.searchTimeoutMs = config.getOrThrow<number>("rideSearchTimeoutSeconds") * 1000;
  }

  async estimate(dto: CircuitEstimateDto): Promise<CircuitEstimateView> {
    const { view } = await this.quote(dto);
    return view;
  }

  /**
   * Booking: re-quote everything from scratch (the app's estimate is advisory),
   * then create the ride in SEARCHING and start matching. Safe to repeat with the
   * same idempotency key: the second call returns the first booking.
   */
  async create(customerUserId: string, dto: CreateCircuitRideDto, headerKey?: string): Promise<CustomerRideView> {
    const customerId = new Types.ObjectId(customerUserId);
    const bookingKey = dto.idempotencyKey ?? headerKey;
    if (bookingKey) {
      const existing = await this.findByBookingKey(customerId, bookingKey);
      if (existing) return this.views.forCustomer(existing);
    }

    const customer = await this.users.findById(customerUserId);
    if (customer.status !== UserStatus.ACTIVE) throw apiForbidden("This account cannot book rides", "USER_BLOCKED");
    await this.rides.assertNoActiveRide(customerId);

    const { view, pkg, rideType, legs } = await this.quote(dto);
    const zone = await this.zones.assertServiceable(dto.pickup);
    const last = view.stops[view.stops.length - 1];
    const allRoadRouted = legs.every((leg) => leg.route.provider === "GOOGLE_ROUTES");

    let ride;
    try {
      ride = await this.rides.insertRide({
        customerId,
        kind: RideKind.CIRCUIT,
        rideType: rideType.code,
        vehicleType: rideType.vehicleType,
        pickup: dto.pickup,
        destination: { address: last.address, latitude: last.latitude, longitude: last.longitude },
        distanceMeters: view.route.distanceMeters,
        durationSeconds: view.route.durationSeconds,
        routeProvider: allRoadRouted ? "GOOGLE_ROUTES" : "HAVERSINE",
        ...(view.route.polyline ? { routePolyline: view.route.polyline } : {}),
        // The package tariff expressed in the ride's fare shape, so payments, earnings,
        // cancellation fees and receipts read it like any other fare.
        fare: {
          currency: view.fare.currency,
          baseFare: view.pricing.basePrice,
          perKmRate: view.pricing.extraDistanceRatePerKm,
          basePerKmRate: view.pricing.extraDistanceRatePerKm,
          perMinuteRate: view.pricing.extraDurationRatePerHour / 60,
          minimumFare: view.pricing.basePrice,
          distanceCharge: view.fare.expectedExtraDistanceCharge,
          timeCharge: view.fare.expectedExtraDurationCharge,
          subtotal: view.fare.estimatedTotal,
          minimumFareApplied: false,
          estimatedFare: view.fare.estimatedTotal,
          pricingVersion: pkg.revision,
        },
        circuit: {
          packageId: pkg._id,
          packageCode: pkg.code,
          packageRevision: pkg.revision,
          name: pkg.name,
          city: pkg.city,
          passengers: dto.passengers,
          stops: view.stops.map((stop) => ({
            order: stop.order,
            placeId: stop.placeId,
            name: stop.name,
            address: stop.address,
            latitude: stop.latitude,
            longitude: stop.longitude,
            status: CircuitStopStatus.UPCOMING,
          })),
          pricing: { ...view.pricing },
          cancellationPolicy: pkg.cancellationPolicy,
          currentStopOrder: 0,
          usage: { distanceMeters: 0, reliable: true },
          warnings: {},
          ...(bookingKey ? { bookingKey } : {}),
        },
        ...(zone ? { zoneId: zone.zoneId, zoneName: zone.zoneName } : {}),
        status: RideStatus.SEARCHING,
        isActive: true,
        requestedAt: new Date(),
        searchExpiresAt: new Date(Date.now() + this.searchTimeoutMs),
      });
    } catch (error) {
      // A repeated tap that lost the race: hand back the booking the winner made.
      if (bookingKey) {
        const existing = await this.findByBookingKey(customerId, bookingKey);
        if (existing) return this.views.forCustomer(existing);
      }
      if (isDuplicateKey(error)) this.logger.warn(`Circuit booking hit a duplicate key: ${(error as Error).message}`);
      throw error;
    }

    await this.transitions.record({
      rideId: ride._id,
      toStatus: RideStatus.SEARCHING,
      actor: { type: RideActorType.CUSTOMER, userId: customerId },
      reason: "CIRCUIT_REQUESTED",
      metadata: {
        circuit: pkg.name,
        packageCode: pkg.code,
        packageRevision: pkg.revision,
        packagePrice: view.fare.packagePrice,
        estimatedFare: view.fare.estimatedTotal,
        passengers: dto.passengers,
      },
    });
    await this.ledger.record({
      rideId: ride._id,
      type: "BOOKED",
      actor: { type: RideActorType.CUSTOMER, userId: customerId },
      data: { packageCode: pkg.code, packageRevision: pkg.revision, rideType: rideType.code, passengers: dto.passengers },
    });
    void this.packages.markBooked(pkg._id);
    this.events.created(ride);
    this.dispatch.scheduleDeadline(ride._id, "search", ride.searchExpiresAt);

    // Same as a normal booking: first matching attempt inline; the sweep retries on failure.
    let current = ride;
    try {
      current = (await this.dispatch.dispatch(ride._id)) ?? ride;
    } catch (error) {
      this.logger.error(`Initial dispatch failed for circuit ${ride.rideCode}`, error instanceof Error ? error.stack : String(error));
    }
    return this.views.forCustomer(current);
  }

  // ── Quote ─────────────────────────────────────────────────────────────

  private async quote(dto: CircuitEstimateDto) {
    const pkg = await this.packages.findActive(dto.packageId);
    const rideType = await this.rideTypes.getBookable(dto.rideType);
    // Each vehicle has its own price on a circuit: the tariff is the chosen one's.
    const tariff = await this.packages.assertBookable(pkg, rideType, dto.passengers);
    const stops = [...pkg.stops].sort((a, b) => a.order - b.order);

    if (haversineMeters(dto.pickup, stops[0]) > this.maxPickupDistanceMeters)
      throw apiBadRequest(
        `Pickup is too far from the start of ${pkg.name}. Choose a pickup within ${Math.round(this.maxPickupDistanceMeters / 1000)} km of ${stops[0].name}.`,
        "CIRCUIT_PICKUP_TOO_FAR",
      );
    await this.zones.assertServiceable(dto.pickup);

    // Pickup → stop 1, then stop → stop. The pickup is the origin; it is never a stop.
    const points = [dto.pickup, ...stops];
    const routes = await Promise.all(points.slice(1).map((point, index) => this.locations.routeBetween(points[index], point)));
    const legs = routes.map((route, index) => ({
      route,
      from: index === 0 ? dto.pickup.address : stops[index - 1].name,
      to: stops[index].name,
    }));
    const distanceMeters = routes.reduce((sum, route) => sum + route.distanceMeters, 0);
    const durationSeconds = routes.reduce((sum, route) => sum + route.durationSeconds, 0);

    const projected = calculateCircuitFare(tariff, distanceMeters, durationSeconds);
    const supply = await this.rides.pickupSupply(dto.pickup, rideType.vehicleType);
    const notices: string[] = [];
    if (projected.extraKm > 0)
      notices.push(`This route is about ${(distanceMeters / 1000).toFixed(1)} km, ${projected.extraKm} km over the included distance.`);
    if (projected.extraBlocks > 0) notices.push("The planned route alone is longer than the included time.");

    const view: CircuitEstimateView = {
      package: {
        id: pkg._id.toString(),
        code: pkg.code,
        name: pkg.name,
        city: pkg.city,
        coverPath: pkg.cover ? `/circuit-packages/${pkg._id.toString()}/cover?v=${pkg.cover.version}` : null,
        revision: pkg.revision,
      },
      rideType: { code: rideType.code, displayName: rideType.displayName, icon: rideType.icon, seatCapacity: rideType.seatCapacity },
      passengers: dto.passengers,
      maxPassengers: Math.min(pkg.maxPassengers, rideType.seatCapacity),
      pickup: { address: dto.pickup.address, latitude: dto.pickup.latitude, longitude: dto.pickup.longitude },
      stops: stops.map(stopView),
      route: {
        distanceMeters,
        durationSeconds,
        provider: routes.every((route) => route.provider === "GOOGLE_ROUTES") ? "GOOGLE_ROUTES" : "HAVERSINE",
        polyline: joinLegs(routes.map((route, index) => ({ from: points[index], to: points[index + 1], polyline: route.polyline }))),
        pickupLeg: { distanceMeters: routes[0].distanceMeters, durationSeconds: routes[0].durationSeconds },
        legs: legs.map((leg) => ({
          from: leg.from,
          to: leg.to,
          distanceMeters: leg.route.distanceMeters,
          durationSeconds: leg.route.durationSeconds,
        })),
      },
      pricing: {
        basePrice: tariff.basePrice,
        includedDistanceMeters: tariff.includedDistanceMeters,
        includedDurationSeconds: tariff.includedDurationSeconds,
        extraDistanceRatePerKm: tariff.extraDistanceRatePerKm,
        extraDurationRatePerHour: tariff.extraDurationRatePerHour,
      },
      fare: {
        currency: "INR",
        packagePrice: tariff.basePrice,
        estimatedTotal: projected.total,
        expectedExtraDistanceCharge: projected.extraDistanceCharge,
        expectedExtraDurationCharge: projected.extraDurationCharge,
        isFinal: false,
      },
      notices,
      pickupEtaSeconds: supply.pickupEtaSeconds,
      driversNearby: supply.driversNearby,
      cancellationPolicy: pkg.cancellationPolicy,
    };
    return { view, pkg: pkg as CircuitPackageDocument, rideType, legs };
  }

  private findByBookingKey(customerId: Types.ObjectId, bookingKey: string) {
    return this.rideModel.findOne({ customerId, "circuit.bookingKey": bookingKey }).select("+otpCode").exec();
  }
}

const stopView = (stop: { order: number; placeId: string; name: string; address: string; latitude: number; longitude: number }): CircuitStopView => ({
  order: stop.order,
  placeId: stop.placeId,
  name: stop.name,
  address: stop.address,
  latitude: stop.latitude,
  longitude: stop.longitude,
});
