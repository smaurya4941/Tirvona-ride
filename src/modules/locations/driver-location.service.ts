import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectModel } from "@nestjs/mongoose";
import type { Model } from "mongoose";
import { Types } from "mongoose";
import { DriverProfile, DriverStatus } from "../drivers/schemas/driver-profile.schema";
import { DRIVER_ENGAGED_STATUSES, RideStatus } from "../rides/ride-state-machine";
import { Ride } from "../rides/schemas/ride.schema";
import type { DriverLocationFixDto } from "./dto/driver-location-fix.dto";
import { DriverLiveLocationStore } from "./driver-live-location.store";
import type { LiveLocation } from "./driver-live-location.store";
import { fromGeoJsonPoint, haversineMeters, toGeoJsonPoint } from "./geo";
import type { GeoCoordinates } from "./geo";
import {
  CheckpointKind,
  CheckpointSource,
  DriverLocationCheckpoint,
} from "./schemas/driver-location-checkpoint.schema";

export type LocationRejection =
  | "DRIVER_NOT_FOUND"
  | "DRIVER_NOT_APPROVED"
  | "DRIVER_OFFLINE"
  | "RATE_LIMITED"
  | "STALE_FIX"
  | "LOW_ACCURACY"
  | "RIDE_MISMATCH";

/** Who should see this fix live: the customer of the driver's engaged ride. */
export interface LocationRelayTarget {
  rideId: string;
  status: RideStatus;
}

export interface ArrivingSignal {
  rideId: string;
  distanceMeters: number;
  etaSeconds: number;
}

export type LocationIngestResult =
  | { accepted: false; reason: LocationRejection }
  | {
      accepted: true;
      location: LiveLocation;
      /** Whether this fix also refreshed the driver's stored position. */
      persisted: boolean;
      relay?: LocationRelayTarget;
      arriving?: ArrivingSignal;
    };

export interface IngestOptions {
  /** Socket traffic is rate limited; the REST fallback is not. */
  enforceRateLimit: boolean;
}

/** Future-dated device clocks are clamped to this much ahead of server time. */
const MAX_CLOCK_SKEW_MS = 5_000;

/**
 * Driver location input for Phase 3 (no Redis).
 *
 * Every accepted fix is *relayed* (the caller pushes it to the ride room), but
 * MongoDB is written only when it is useful:
 *
 * - `driver_profiles.currentLocation` — at most every
 *   DRIVER_LOCATION_PERSIST_INTERVAL_SECONDS, or sooner after a real move.
 *   That keeps matching fresh without a write per ping.
 * - `driver_location_checkpoints` — lifecycle points (accept, arriving,
 *   arrived, start, complete, cancel) plus one coarse trail sample per
 *   RIDE_CHECKPOINT_INTERVAL_SECONDS while the ride is under way.
 */
@Injectable()
export class DriverLocationService {
  private readonly logger = new Logger(DriverLocationService.name);
  private readonly staleMs: number;
  private readonly persistIntervalMs: number;
  private readonly persistDistanceMeters: number;
  private readonly minIntervalMs: number;
  private readonly maxAccuracyMeters: number;
  private readonly maxFixAgeMs: number;
  private readonly arrivingRadiusMeters: number;
  private readonly checkpointIntervalMs: number;
  private readonly averageSpeedMps: number;

  constructor(
    @InjectModel(DriverProfile.name) private readonly driverModel: Model<DriverProfile>,
    @InjectModel(Ride.name) private readonly rideModel: Model<Ride>,
    @InjectModel(DriverLocationCheckpoint.name)
    private readonly checkpointModel: Model<DriverLocationCheckpoint>,
    private readonly store: DriverLiveLocationStore,
    config: ConfigService,
  ) {
    this.staleMs = config.getOrThrow<number>("driverLocationStaleSeconds") * 1000;
    this.persistIntervalMs = config.getOrThrow<number>("driverLocationPersistIntervalSeconds") * 1000;
    this.persistDistanceMeters = config.getOrThrow<number>("driverLocationPersistDistanceMeters");
    this.minIntervalMs = config.getOrThrow<number>("driverLocationMinIntervalMs");
    this.maxAccuracyMeters = config.getOrThrow<number>("driverLocationMaxAccuracyMeters");
    this.maxFixAgeMs = config.getOrThrow<number>("driverLocationMaxFixAgeSeconds") * 1000;
    this.arrivingRadiusMeters = config.getOrThrow<number>("driverArrivingRadiusMeters");
    this.checkpointIntervalMs = config.getOrThrow<number>("rideCheckpointIntervalSeconds") * 1000;
    this.averageSpeedMps = config.getOrThrow<number>("routeAverageSpeedKmph") / 3.6;
  }

  /** How old a stored location may be for the driver to still be matchable. */
  get freshnessWindowMs(): number {
    return this.staleMs;
  }

  async ingest(driverId: string, fix: DriverLocationFixDto, options: IngestOptions): Promise<LocationIngestResult> {
    const now = new Date();
    const recordedAt = this.clampRecordedAt(fix.recordedAt, now);
    if (now.getTime() - recordedAt.getTime() > this.maxFixAgeMs) return { accepted: false, reason: "STALE_FIX" };
    if (fix.accuracy !== undefined && fix.accuracy > this.maxAccuracyMeters)
      return { accepted: false, reason: "LOW_ACCURACY" };
    if (options.enforceRateLimit && !this.store.tryAccept(driverId, this.minIntervalMs, now.getTime()))
      return { accepted: false, reason: "RATE_LIMITED" };

    const driver = await this.driverModel
      .findById(driverId)
      .select("driverStatus isOnline currentRideId currentLocation locationUpdatedAt")
      .lean()
      .exec();
    if (!driver) return { accepted: false, reason: "DRIVER_NOT_FOUND" };
    if (driver.driverStatus !== DriverStatus.APPROVED) return { accepted: false, reason: "DRIVER_NOT_APPROVED" };
    if (!driver.isOnline) return { accepted: false, reason: "DRIVER_OFFLINE" };
    if (fix.rideId && !driver.currentRideId?.equals(fix.rideId)) return { accepted: false, reason: "RIDE_MISMATCH" };

    const location: LiveLocation = {
      latitude: fix.latitude,
      longitude: fix.longitude,
      heading: fix.heading,
      speed: fix.speed,
      accuracy: fix.accuracy,
      recordedAt,
      receivedAt: now,
    };
    this.store.save(driverId, location);

    const persisted = await this.persistIfDue(driver, location, now);

    if (!driver.currentRideId) return { accepted: true, location, persisted };
    const ride = await this.rideModel
      .findOne({ _id: driver.currentRideId, driverId: driver._id })
      .select("status pickup arrivingNotifiedAt")
      .lean()
      .exec();
    if (!ride || !DRIVER_ENGAGED_STATUSES.includes(ride.status)) return { accepted: true, location, persisted };

    const rideId = ride._id.toString();
    const arriving =
      ride.status === RideStatus.DRIVER_ACCEPTED && !ride.arrivingNotifiedAt
        ? await this.detectArriving(ride._id, driver._id, ride.pickup, location)
        : undefined;

    if (
      (ride.status === RideStatus.DRIVER_ACCEPTED || ride.status === RideStatus.RIDE_STARTED) &&
      this.store.checkpointDue(driverId, this.checkpointIntervalMs, now.getTime())
    )
      await this.writeCheckpoint(ride._id, driver._id, CheckpointKind.TRIP, location, CheckpointSource.LIVE);

    return { accepted: true, location, persisted, relay: { rideId, status: ride.status }, arriving };
  }

  /**
   * Lifecycle checkpoint (accept/arrive/start/complete/cancel). Uses the live
   * fix if one is fresh, otherwise the last persisted position; silently skips
   * when neither exists. Never throws — it must not fail a ride action.
   */
  async recordCheckpoint(rideId: Types.ObjectId, driverId: Types.ObjectId, kind: CheckpointKind): Promise<void> {
    try {
      const live = this.store.latest(driverId.toString(), this.staleMs);
      if (live) {
        await this.writeCheckpoint(rideId, driverId, kind, live, CheckpointSource.LIVE);
      } else {
        const driver = await this.driverModel
          .findById(driverId)
          .select("currentLocation locationUpdatedAt")
          .lean()
          .exec();
        if (!driver?.currentLocation) return;
        const at = driver.locationUpdatedAt ?? new Date();
        await this.writeCheckpoint(
          rideId,
          driverId,
          kind,
          { ...fromGeoJsonPoint(driver.currentLocation), recordedAt: at, receivedAt: at },
          CheckpointSource.LAST_KNOWN,
        );
      }
      if (kind === CheckpointKind.COMPLETED || kind === CheckpointKind.CANCELLED)
        this.store.resetCheckpointClock(driverId.toString());
    } catch (error) {
      this.logger.error(
        `Failed to record ${kind} checkpoint for ride ${rideId.toString()}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  async checkpoints(rideId: Types.ObjectId): Promise<
    Array<{ kind: CheckpointKind; latitude: number; longitude: number; source: CheckpointSource; recordedAt: Date }>
  > {
    const rows = await this.checkpointModel.find({ rideId }).sort({ recordedAt: 1, _id: 1 }).lean().exec();
    return rows.map((row) => ({
      kind: row.kind,
      ...fromGeoJsonPoint(row.location),
      source: row.source,
      recordedAt: row.recordedAt,
    }));
  }

  /**
   * Best current position of a driver: the live fix if fresh, else the last
   * persisted one. Used to place the driver on the customer's map at once.
   */
  async lastKnown(
    driverId: Types.ObjectId,
  ): Promise<(GeoCoordinates & { heading?: number; updatedAt: Date }) | undefined> {
    const live = this.store.latest(driverId.toString(), this.staleMs);
    if (live)
      return { latitude: live.latitude, longitude: live.longitude, heading: live.heading, updatedAt: live.receivedAt };
    const driver = await this.driverModel.findById(driverId).select("currentLocation locationUpdatedAt").lean().exec();
    if (!driver?.currentLocation) return undefined;
    return { ...fromGeoJsonPoint(driver.currentLocation), updatedAt: driver.locationUpdatedAt ?? new Date(0) };
  }

  /** Called when a driver goes online with coordinates via REST. */
  remember(driverId: string, coordinates: GeoCoordinates): void {
    const now = new Date();
    this.store.save(driverId, { ...coordinates, recordedAt: now, receivedAt: now });
  }

  forget(driverId: string): void {
    this.store.forget(driverId);
  }

  private async persistIfDue(
    driver: { _id: Types.ObjectId; currentLocation?: DriverProfile["currentLocation"]; locationUpdatedAt?: Date },
    location: LiveLocation,
    now: Date,
  ): Promise<boolean> {
    const lastWrite = driver.locationUpdatedAt?.getTime();
    const moved = driver.currentLocation
      ? haversineMeters(fromGeoJsonPoint(driver.currentLocation), location)
      : Number.POSITIVE_INFINITY;
    const due =
      lastWrite === undefined ||
      now.getTime() - lastWrite >= this.persistIntervalMs ||
      moved >= this.persistDistanceMeters;
    if (!due) return false;

    await this.driverModel
      .updateOne(
        { _id: driver._id, isOnline: true },
        {
          $set: {
            currentLocation: toGeoJsonPoint(location),
            locationUpdatedAt: now,
            lastSeenAt: now,
          },
        },
      )
      .exec();
    return true;
  }

  private async detectArriving(
    rideId: Types.ObjectId,
    driverId: Types.ObjectId,
    pickup: GeoCoordinates,
    location: LiveLocation,
  ): Promise<ArrivingSignal | undefined> {
    const distanceMeters = Math.round(haversineMeters(location, pickup));
    if (distanceMeters > this.arrivingRadiusMeters) return undefined;

    // Exactly-once across fixes and API instances: the first writer wins.
    const claimed = await this.rideModel
      .updateOne(
        { _id: rideId, status: RideStatus.DRIVER_ACCEPTED, arrivingNotifiedAt: { $exists: false } },
        { $set: { arrivingNotifiedAt: new Date() } },
      )
      .exec();
    if (claimed.modifiedCount !== 1) return undefined;

    await this.writeCheckpoint(rideId, driverId, CheckpointKind.ARRIVING, location, CheckpointSource.LIVE);
    const speed = location.speed && location.speed > 1 ? location.speed : this.averageSpeedMps;
    return { rideId: rideId.toString(), distanceMeters, etaSeconds: Math.max(30, Math.round(distanceMeters / speed)) };
  }

  private async writeCheckpoint(
    rideId: Types.ObjectId,
    driverId: Types.ObjectId,
    kind: CheckpointKind,
    location: LiveLocation,
    source: CheckpointSource,
  ): Promise<void> {
    await this.checkpointModel.create({
      rideId,
      driverId,
      kind,
      location: toGeoJsonPoint(location),
      heading: location.heading,
      speed: location.speed,
      accuracy: location.accuracy,
      source,
      recordedAt: location.recordedAt,
    });
  }

  private clampRecordedAt(recordedAt: Date | undefined, now: Date): Date {
    if (!recordedAt || Number.isNaN(recordedAt.getTime())) return now;
    return recordedAt.getTime() > now.getTime() + MAX_CLOCK_SKEW_MS ? now : recordedAt;
  }
}
