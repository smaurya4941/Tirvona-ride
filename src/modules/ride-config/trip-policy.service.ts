import { Injectable } from "@nestjs/common";
import { apiBadRequest } from "../../common/exceptions/api.exception";
import type { GeoCoordinates } from "../locations/geo";
import { haversineMeters } from "../locations/geo";
import { LocationsService } from "../locations/locations.service";
import type { RouteEstimate } from "../locations/route-estimator";
import { checkTripDistance, maxDistanceMeters } from "./distance-policy";
import type { AppliedDistancePolicy, DistanceViolation } from "./distance-policy";
import { RideDistanceConfigService } from "./ride-distance-config.service";
import type { RideDistanceConfigDocument } from "./schemas/ride-distance-config.schema";

export interface PolicedTrip {
  route: RouteEstimate;
  policy: AppliedDistancePolicy;
}

export type TripOutcome =
  | ({ ok: true } & PolicedTrip)
  | { ok: false; rideType: string; error: Error };

const violationError = (violation: DistanceViolation): Error =>
  apiBadRequest(violation.message, violation.code, violation.data);

const snapshotOf = (config: RideDistanceConfigDocument): AppliedDistancePolicy => ({
  rideType: config.rideType,
  minDistanceMeters: config.minDistanceMeters,
  maxDistanceMeters: maxDistanceMeters(config),
  configId: config._id.toString(),
  configVersion: config.version,
});

/**
 * THE place that decides whether a trip is long enough / short enough for a
 * ride type. Estimate, booking and promo preview all come through here, each
 * time reading the admin's current limits from MongoDB — nothing is cached
 * and no earlier estimate is trusted.
 *
 * The test is on the straight line between pickup and destination, made
 * before any route is requested so an obviously bad request never reaches
 * the (billable) maps provider.
 */
@Injectable()
export class TripPolicyService {
  constructor(
    private readonly distanceConfigs: RideDistanceConfigService,
    private readonly locations: LocationsService,
  ) {}

  /** Route + the policy the trip was accepted under, or the business error (400 short/long, 503 missing config). */
  async estimateTrip(rideType: string, pickup: GeoCoordinates, destination: GeoCoordinates): Promise<PolicedTrip> {
    const config = await this.distanceConfigs.getRequired(rideType);
    const violation = checkTripDistance(config, haversineMeters(pickup, destination));
    if (violation) throw violationError(violation);
    return { route: await this.locations.routeBetween(pickup, destination), policy: snapshotOf(config) };
  }

  /**
   * One route for several ride types, each judged by its own limits. A ride
   * type the trip does not fit (or that has no usable limits) is reported
   * individually so the quote can hide it; the route is only requested when at
   * least one type accepts the straight line.
   */
  async estimateTripForAll(
    rideTypes: string[],
    pickup: GeoCoordinates,
    destination: GeoCoordinates,
  ): Promise<TripOutcome[]> {
    const straightLine = haversineMeters(pickup, destination);
    const configs = await this.distanceConfigs.findMany(rideTypes);
    type Verdict = { rideType: string; policy: AppliedDistancePolicy } | { rideType: string; error: Error };
    const verdicts = rideTypes.map((rideType): Verdict => {
      try {
        const config = this.distanceConfigs.assertUsable(rideType, configs.get(rideType) ?? null);
        const violation = checkTripDistance(config, straightLine);
        return violation ? { rideType, error: violationError(violation) } : { rideType, policy: snapshotOf(config) };
      } catch (error) {
        return { rideType, error: error as Error };
      }
    });
    const route = verdicts.some((verdict) => "policy" in verdict)
      ? await this.locations.routeBetween(pickup, destination)
      : null;
    return verdicts.map((verdict): TripOutcome =>
      "policy" in verdict && route
        ? { ok: true, route, policy: verdict.policy }
        : { ok: false, rideType: verdict.rideType, error: "error" in verdict ? verdict.error : new Error("No route") },
    );
  }
}
