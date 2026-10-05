import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import type { Model } from "mongoose";
import { Types } from "mongoose";
import type { AuthenticatedUser } from "../../common/types/jwt-payload";
import { UserRole } from "../../common/types/user-role.enum";
import { DriverLocationService } from "../locations/driver-location.service";
import { LiveRouteService } from "../locations/live-route.service";
import type { LiveRouteStage } from "../locations/live-route.service";
import type { RouteProvider } from "../locations/route-estimator";
import { RideKind } from "../circuit-rides/circuit-ride.types";
import { rideNotFound } from "./ride-errors";
import { RideStatus } from "./ride-state-machine";
import { RidesService } from "./rides.service";
import { Ride } from "./schemas/ride.schema";

export interface LiveRouteView {
  rideId: string;
  /** APPROACH = driver → pickup, TRIP = driver → destination (a circuit: driver → current stop). */
  stage: LiveRouteStage;
  origin: { latitude: number; longitude: number };
  destination: { latitude: number; longitude: number };
  distanceMeters: number;
  durationSeconds: number;
  provider: RouteProvider;
  /** Road path (Google encoded polyline); absent for straight-line routes. */
  polyline?: string;
  computedAt: Date;
}

/** The leg a ride in this status is on; undefined = no live route to show. */
const STAGE_BY_STATUS: Partial<Record<RideStatus, LiveRouteStage>> = {
  [RideStatus.DRIVER_ACCEPTED]: "APPROACH",
  [RideStatus.RIDE_STARTED]: "TRIP",
};

/**
 * `GET /rides/:id/route`: the driver's current road route, for the ride's own
 * customer or driver. Cheap to poll — see {@link LiveRouteService} for when
 * the routing provider is actually called.
 */
@Injectable()
export class RideRouteService {
  constructor(
    @InjectModel(Ride.name) private readonly rideModel: Model<Ride>,
    private readonly rides: RidesService,
    private readonly driverLocations: DriverLocationService,
    private readonly liveRoutes: LiveRouteService,
  ) {}

  /**
   * Null while there is no leg to route (searching, driver waiting at the
   * pickup, finished) or the driver's position is not known yet.
   */
  async forUser(user: AuthenticatedUser, rideId: string): Promise<LiveRouteView | null> {
    const owner =
      user.role === UserRole.DRIVER
        ? { driverId: (await this.rides.resolveDriver(user.userId))._id }
        : { customerId: new Types.ObjectId(user.userId) };
    const ride = await this.rideModel
      .findOne({ _id: new Types.ObjectId(rideId), ...owner })
      .select("status driverId pickup destination kind circuit.stops circuit.currentStopOrder")
      .lean()
      .exec();
    if (!ride) throw rideNotFound();

    const stage = STAGE_BY_STATUS[ride.status];
    if (!stage || !ride.driverId) return null;
    const driver = await this.driverLocations.lastKnown(ride.driverId);
    if (!driver) return null;

    // A circuit is driven stop by stop: the trip leg leads to the current stop.
    const currentStop =
      ride.kind === RideKind.CIRCUIT ? ride.circuit?.stops.find((stop) => stop.order === ride.circuit?.currentStopOrder) : undefined;
    const target = stage === "APPROACH" ? ride.pickup : (currentStop ?? ride.destination);
    const destination = { latitude: target.latitude, longitude: target.longitude };
    const route = await this.liveRoutes.forRide(
      rideId,
      stage,
      { latitude: driver.latitude, longitude: driver.longitude },
      destination,
    );
    return {
      rideId,
      stage: route.stage,
      origin: route.origin,
      destination: route.destination,
      distanceMeters: route.distanceMeters,
      durationSeconds: route.durationSeconds,
      provider: route.provider,
      ...(route.polyline ? { polyline: route.polyline } : {}),
      computedAt: route.computedAt,
    };
  }
}
