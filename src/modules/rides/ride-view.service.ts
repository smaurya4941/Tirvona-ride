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
import type { RideDocument, RideLocation, RideVehicle } from "./schemas/ride.schema";

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
}

export interface RidePaymentView {
  paymentId: string;
  gatewayPaymentId?: string;
  method?: string;
  amount?: number;
  paidAt?: Date;
  failureReason?: string;
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
  cancellation?: { cancelledBy: RideActorType; reason?: string };
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
        ? { cancelledBy: ride.cancellation.cancelledBy, reason: ride.cancellation.reason }
        : undefined,
      paymentStatus: effectivePaymentStatus(ride),
      payment: ride.payment
        ? {
            paymentId: ride.payment.paymentId.toString(),
            gatewayPaymentId: ride.payment.gatewayPaymentId,
            method: ride.payment.method,
            amount: ride.payment.amount,
            paidAt: ride.payment.paidAt,
            failureReason: ride.payment.failureReason,
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
