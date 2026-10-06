import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { TtlCache } from "../../common/cache/ttl-cache";
import type { GeoCoordinates } from "./geo";
import { haversineMeters } from "./geo";
import { LocationsService } from "./locations.service";
import type { RouteEstimate } from "./route-estimator";

/** Which leg of an in-progress ride the driver is on. */
export type LiveRouteStage = "APPROACH" | "TRIP";

export interface LiveRoute extends RouteEstimate {
  stage: LiveRouteStage;
  /** The driver position the route was computed from. */
  origin: GeoCoordinates;
  destination: GeoCoordinates;
  computedAt: Date;
}

/**
 * Entries are kept a few refresh windows (finished rides simply expire), so a
 * stationary driver's route is still served from cache between refreshes.
 */
const RETENTION_FACTOR = 4;
const MAX_TRACKED_RIDES = 5_000;

/**
 * The live driver → pickup (APPROACH) / driver → destination (TRIP) route of
 * a ride, shared by its customer and driver.
 *
 * Both apps poll it, but the routing provider is called only when the cached
 * route is stale: the stage changed, the driver has moved more than
 * ROUTES_LIVE_REFRESH_METERS from where it was computed, or it is older than
 * ROUTES_LIVE_REFRESH_SECONDS. Concurrent polls for one ride share one call.
 */
@Injectable()
export class LiveRouteService {
  private readonly routes: TtlCache<LiveRoute>;
  private readonly inFlight = new Map<string, Promise<LiveRoute>>();
  private readonly refreshMs: number;
  private readonly refreshMeters: number;

  constructor(
    private readonly locations: LocationsService,
    config: ConfigService,
  ) {
    this.refreshMs =
      config.getOrThrow<number>("routesLiveRefreshSeconds") * 1000;
    this.refreshMeters = config.getOrThrow<number>("routesLiveRefreshMeters");
    this.routes = new TtlCache<LiveRoute>(MAX_TRACKED_RIDES);
  }

  async forRide(
    rideId: string,
    stage: LiveRouteStage,
    driver: GeoCoordinates,
    destination: GeoCoordinates,
  ): Promise<LiveRoute> {
    const cached = this.routes.get(rideId);
    if (cached && this.isFresh(cached, stage, driver, destination))
      return cached;

    const pending = this.inFlight.get(rideId);
    if (pending) return pending;
    const load = this.locations
      .routeBetween(driver, destination)
      .then((route): LiveRoute => {
        const live: LiveRoute = {
          ...route,
          stage,
          origin: driver,
          destination,
          computedAt: new Date(),
        };
        this.routes.set(rideId, live, this.refreshMs * RETENTION_FACTOR);
        return live;
      })
      .finally(() => this.inFlight.delete(rideId));
    this.inFlight.set(rideId, load);
    return load;
  }

  private isFresh(
    route: LiveRoute,
    stage: LiveRouteStage,
    driver: GeoCoordinates,
    destination: GeoCoordinates,
  ): boolean {
    return (
      route.stage === stage &&
      route.destination.latitude === destination.latitude &&
      route.destination.longitude === destination.longitude &&
      Date.now() - route.computedAt.getTime() < this.refreshMs &&
      haversineMeters(route.origin, driver) < this.refreshMeters
    );
  }
}
