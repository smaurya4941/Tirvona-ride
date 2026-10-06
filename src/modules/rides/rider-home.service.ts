import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectModel } from "@nestjs/mongoose";
import { Types } from "mongoose";
import type { Model } from "mongoose";
import type { GeoCoordinates } from "../locations/geo";
import { haversineMeters } from "../locations/geo";
import { MatchingService } from "../matching/matching.service";
import { PlatformSettingsService } from "../ride-config/platform-settings.service";
import type { VehicleType } from "../vehicles/schemas/vehicle.schema";
import { Ride } from "./schemas/ride.schema";

/** Two destinations closer than this are the same recent entry. */
const SAME_DESTINATION_METERS = 50;
/** Rides scanned for distinct destinations (a commuter repeats a lot). */
const RECENT_SCAN_LIMIT = 60;
/** ~110 m: enough for "cars around you", too coarse to follow a driver home. */
const DRIVER_POSITION_DECIMALS = 3;

export interface NearbyDriversView {
  /** Approximate positions of free drivers; no ids, names or plates. */
  drivers: Array<{
    latitude: number;
    longitude: number;
    vehicleType: VehicleType | null;
  }>;
  radiusMeters: number;
}

export interface RecentDestinationView {
  address: string;
  latitude: number;
  longitude: number;
  lastUsedAt: Date;
}

/** Read-only data for the rider's Home and "Where to?" screens. */
@Injectable()
export class RiderHomeService {
  private readonly nearbyLimit: number;

  constructor(
    @InjectModel(Ride.name) private readonly rides: Model<Ride>,
    private readonly matching: MatchingService,
    private readonly settings: PlatformSettingsService,
    config: ConfigService,
  ) {
    this.nearbyLimit = config.getOrThrow<number>("nearbyDriversLimit");
  }

  async nearbyDrivers(point: GeoCoordinates): Promise<NearbyDriversView> {
    // The admin's current nearby-drivers radius, read per request.
    const radiusMeters = await this.settings.nearbyDriversRadiusMeters();
    const found = await this.matching.nearbyAvailable(
      point,
      radiusMeters,
      this.nearbyLimit,
    );
    const round = (value: number) =>
      Number(value.toFixed(DRIVER_POSITION_DECIMALS));
    return {
      drivers: found.map((driver) => ({
        latitude: round(driver.latitude),
        longitude: round(driver.longitude),
        vehicleType: driver.vehicleType ?? null,
      })),
      radiusMeters,
    };
  }

  /**
   * Distinct destinations of the rider's own bookings, most recent first.
   * Cancelled bookings count too: the rider still meant to go there.
   */
  async recentDestinations(
    customerId: string,
    limit: number,
  ): Promise<RecentDestinationView[]> {
    const rows = await this.rides
      .find({ customerId: new Types.ObjectId(customerId) })
      .sort({ requestedAt: -1 })
      .limit(RECENT_SCAN_LIMIT)
      .select("destination requestedAt")
      .lean<
        Array<{
          destination: { address: string; latitude: number; longitude: number };
          requestedAt: Date;
        }>
      >();
    const recent: RecentDestinationView[] = [];
    for (const row of rows) {
      if (recent.length >= limit) break;
      const { address, latitude, longitude } = row.destination;
      if (
        recent.some(
          (seen) =>
            haversineMeters(seen, { latitude, longitude }) <
            SAME_DESTINATION_METERS,
        )
      )
        continue;
      recent.push({
        address,
        latitude,
        longitude,
        lastUsedAt: row.requestedAt,
      });
    }
    return recent;
  }
}
