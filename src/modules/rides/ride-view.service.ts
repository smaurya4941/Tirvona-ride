import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import type { Model, Types } from "mongoose";
import { DriverProfile } from "../drivers/schemas/driver-profile.schema";
import type { DriverProfileDocument } from "../drivers/schemas/driver-profile.schema";
import { fromGeoJsonPoint } from "../locations/geo";
import { DriverLocationService } from "../locations/driver-location.service";
import { LocationsService } from "../locations/locations.service";
import { User } from "../users/schemas/user.schema";
import type { UserDocument } from "../users/schemas/user.schema";
import { effectivePaymentStatus } from "./ride-payment-status";
import type { RidePaymentStatus } from "./ride-payment-status";
import { DRIVER_ENGAGED_STATUSES, RideStatus } from "./ride-state-machine";
import type { RideActorType } from "./ride-state-machine";
import type { RideDocument, RideFinalFare, RideLocation, RideVehicle } from "./schemas/ride.schema";

export interface RideFareView {
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
  finalFare?: number;
  /** Promo discount (estimate until completion), rupees. */
  discount?: number;
  /** What the customer pays after the discount; absent when no promo. */
  payableFare?: number;
  /** The frozen final bill: actual trip measured and each component (absent until completion). */
  final?: RideFinalFareView;
}

export interface RideFinalFareView {
  distanceMeters: number;
  durationSeconds: number;
  distanceSource: string;
  durationSource: string;
  baseFare: number;
  distanceCharge: number;
  timeCharge: number;
  subtotal: number;
  minimumFareApplied: boolean;
  capApplied: boolean;
  total: number;
  discount: number;
  payable: number;
  pricingVersion: number;
}

export function finalFareView(final?: RideFinalFare): RideFinalFareView | undefined {
  if (!final) return undefined;
  return {
    distanceMeters: final.distanceMeters,
    durationSeconds: final.durationSeconds,
    distanceSource: final.distanceSource,
    durationSource: final.durationSource,
    baseFare: final.baseFare,
    distanceCharge: final.distanceCharge,
    timeCharge: final.timeCharge,
    subtotal: final.subtotal,
    minimumFareApplied: final.minimumFareApplied,
    capApplied: final.capApplied,
    total: final.total,
    discount: final.discount,
    payable: final.payable,
    pricingVersion: final.pricingVersion,
  };
}

export interface RidePaymentView {
  paymentId: string;
  gatewayPaymentId?: string;
  method?: string;
  amount?: number;
  paidAt?: Date;
  failureReason?: string;
  refundedAmount?: number;
}

export interface RideView {
  id: string;
  rideCode: string;
  status: RideStatus;
  /** Monotonic per ride; clients keep the snapshot with the highest value. */
  stateVersion: number;
  rideType: string;
  vehicleType: string;
  pickup: RideLocation;
  destination: RideLocation;
  distanceMeters: number;
  durationSeconds: number;
  routeProvider: string;
  /** Pickup → destination road path (Google encoded polyline); absent for straight-line routes. */
  routePolyline?: string;
  fare: RideFareView;
  requestedAt: Date;
  assignedAt?: Date;
  acceptedAt?: Date;
  arrivedAt?: Date;
  startedAt?: Date;
  completedAt?: Date;
  cancelledAt?: Date;
  expiredAt?: Date;
  /** Only while SEARCHING — lets the app show how long it will keep trying. */
  searchExpiresAt?: Date;
  cancellation?: {
    cancelledBy: RideActorType;
    reason?: string;
    reasonCode?: string;
    feeAmount?: number;
    /** NOT_APPLICABLE | DUE | WAIVED | COLLECTED */
    feeStatus?: string;
  };
  promo?: { code: string; title: string; discount: number };
  zone?: { id: string; name: string };
  /** Money state (Phase 4). COMPLETED + PENDING/FAILED means "pay now". */
  paymentStatus: RidePaymentStatus;
  payment?: RidePaymentView;
}

export interface RideDriverInfo {
  name: string;
  phone: string;
  ratingAverage: number;
  ratingCount: number;
  totalRides: number;
  vehicle?: Omit<RideVehicle, "vehicleId">;
  /**
   * Last known position once the driver is committed (accepted → started),
   * so the customer map can place the driver before the next live update.
   */
  location?: { latitude: number; longitude: number; heading?: number; updatedAt: Date };
}

export interface CustomerRideView extends RideView {
  driver?: RideDriverInfo;
  /** Present only in DRIVER_ARRIVED, only for the ride's own customer. */
  otp?: { code: string; expiresAt?: Date };
}

export interface DriverRideView extends RideView {
  customer: { name: string; phone?: string };
  /** Respond before this or the request moves to another driver. */
  assignmentExpiresAt?: Date;
  /** Approximate straight-line distance from the driver to the pickup. */
  pickupDistanceMeters?: number;
}

const fullName = (user?: Pick<UserDocument, "firstName" | "lastName"> | null): string =>
  user ? [user.firstName, user.lastName].filter(Boolean).join(" ") : "Tirvona user";

// Driver details are shown from assignment until the ride closes normally.
const SHOWS_DRIVER: readonly RideStatus[] = [
  RideStatus.DRIVER_ASSIGNED,
  ...DRIVER_ENGAGED_STATUSES,
  RideStatus.COMPLETED,
  RideStatus.CANCELLED,
];

@Injectable()
export class RideViewService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<User>,
    @InjectModel(DriverProfile.name) private readonly driverModel: Model<DriverProfile>,
    private readonly locations: LocationsService,
    private readonly driverLocations: DriverLocationService,
  ) {}

  base(ride: RideDocument): RideView {
    return {
      id: ride._id.toString(),
      rideCode: ride.rideCode,
      status: ride.status,
      stateVersion: ride.stateVersion ?? 0,
      rideType: ride.rideType,
      vehicleType: ride.vehicleType,
      pickup: { address: ride.pickup.address, latitude: ride.pickup.latitude, longitude: ride.pickup.longitude },
      destination: {
        address: ride.destination.address,
        latitude: ride.destination.latitude,
        longitude: ride.destination.longitude,
      },
      distanceMeters: ride.distanceMeters,
      durationSeconds: ride.durationSeconds,
      routeProvider: ride.routeProvider,
      routePolyline: ride.routePolyline,
      fare: {
        currency: ride.fare.currency,
        baseFare: ride.fare.baseFare,
        perKmRate: ride.fare.perKmRate,
        perMinuteRate: ride.fare.perMinuteRate,
        minimumFare: ride.fare.minimumFare,
        distanceCharge: ride.fare.distanceCharge,
        timeCharge: ride.fare.timeCharge,
        subtotal: ride.fare.subtotal,
        minimumFareApplied: ride.fare.minimumFareApplied,
        estimatedFare: ride.fare.estimatedFare,
        finalFare: ride.fare.finalFare,
        discount: ride.fare.discount,
        payableFare: ride.fare.payableFare,
        final: finalFareView(ride.fare.final),
      },
      requestedAt: ride.requestedAt,
      assignedAt: ride.assignedAt,
      acceptedAt: ride.acceptedAt,
      arrivedAt: ride.arrivedAt,
      startedAt: ride.startedAt,
      completedAt: ride.completedAt,
      cancelledAt: ride.cancelledAt,
      expiredAt: ride.expiredAt,
      searchExpiresAt: ride.status === RideStatus.SEARCHING ? ride.searchExpiresAt : undefined,
      cancellation: ride.cancellation
        ? {
            cancelledBy: ride.cancellation.cancelledBy,
            reason: ride.cancellation.reason,
            reasonCode: ride.cancellation.reasonCode,
            feeAmount: ride.cancellation.feeAmount,
            feeStatus: ride.cancellation.feeStatus,
          }
        : undefined,
      promo: ride.promo
        ? { code: ride.promo.code, title: ride.promo.title, discount: ride.fare.discount ?? ride.promo.estimatedDiscount }
        : undefined,
      zone: ride.zoneId && ride.zoneName ? { id: ride.zoneId.toString(), name: ride.zoneName } : undefined,
      paymentStatus: effectivePaymentStatus(ride),
      payment: ride.payment
        ? {
            paymentId: ride.payment.paymentId.toString(),
            gatewayPaymentId: ride.payment.gatewayPaymentId,
            method: ride.payment.method,
            amount: ride.payment.amount,
            paidAt: ride.payment.paidAt,
            failureReason: ride.payment.failureReason,
            refundedAmount: ride.payment.refundedAmount,
          }
        : undefined,
    };
  }

  /** `ride` must have been loaded with `+otpCode` for the OTP to appear. */
  async forCustomer(ride: RideDocument): Promise<CustomerRideView> {
    const view: CustomerRideView = this.base(ride);
    if (ride.driverId && SHOWS_DRIVER.includes(ride.status)) {
      view.driver = await this.driverInfo(ride.driverId, ride.vehicle);
      if (view.driver && DRIVER_ENGAGED_STATUSES.includes(ride.status))
        view.driver.location = await this.driverLocations.lastKnown(ride.driverId);
      // Like the customer's number for the driver, the driver's number is
      // shared only while the driver is committed to the ride (accepted →
      // started): not while an offer is pending, and not after it ends.
      else if (view.driver) view.driver.phone = "";
    }
    if (ride.status === RideStatus.DRIVER_ARRIVED && ride.otpCode)
      view.otp = { code: ride.otpCode, expiresAt: ride.otpExpiresAt };
    return view;
  }

  async forDriver(ride: RideDocument, driver: DriverProfileDocument): Promise<DriverRideView> {
    const customer = await this.userModel
      .findById(ride.customerId)
      .select("firstName lastName phone")
      .lean()
      .exec();
    // The customer's phone is shared only once the driver has committed.
    const engaged = DRIVER_ENGAGED_STATUSES.includes(ride.status);
    return {
      ...this.base(ride),
      customer: {
        name: engaged ? fullName(customer) : (customer?.firstName ?? "Customer"),
        phone: engaged ? customer?.phone : undefined,
      },
      assignmentExpiresAt:
        ride.status === RideStatus.DRIVER_ASSIGNED ? ride.assignmentExpiresAt : undefined,
      pickupDistanceMeters: driver.currentLocation
        ? this.locations.approximateDistanceMeters(fromGeoJsonPoint(driver.currentLocation), ride.pickup)
        : ride.driverDistanceMeters,
    };
  }

  async driverInfo(driverId: Types.ObjectId, vehicle?: RideVehicle): Promise<RideDriverInfo | undefined> {
    const profile = await this.driverModel.findById(driverId).lean().exec();
    if (!profile) return undefined;
    const user = await this.userModel
      .findById(profile.userId)
      .select("firstName lastName phone")
      .lean()
      .exec();
    return {
      name: fullName(user),
      phone: user?.phone ?? "",
      ratingAverage: profile.ratingAverage,
      ratingCount: profile.ratingCount ?? 0,
      totalRides: profile.totalRides,
      vehicle: vehicle
        ? {
            vehicleType: vehicle.vehicleType,
            registrationNumber: vehicle.registrationNumber,
            make: vehicle.make,
            model: vehicle.model,
            color: vehicle.color,
          }
        : undefined,
    };
  }
}
