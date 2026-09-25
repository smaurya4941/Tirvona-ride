import { Injectable } from "@nestjs/common";
import { DomainEventsService } from "../../infrastructure/events/domain-events.service";
import type { DriverLocationFixDto } from "../locations/dto/driver-location-fix.dto";
import { DriverLocationService } from "../locations/driver-location.service";
import type { LocationIngestResult } from "../locations/driver-location.service";
import { RideEvent } from "./realtime.constants";
import { RealtimeService } from "./realtime.service";

export interface RelayOptions {
  enforceRateLimit: boolean;
  /** The sending socket, so a driver does not get their own fix echoed back. */
  exceptSocketId?: string;
}

/**
 * Driver GPS → (validate, maybe persist) → customer's ride room.
 * Used by the `driver.location` socket message and the REST fallback
 * `PATCH /drivers/location`, so both paths behave identically.
 */
@Injectable()
export class LocationRelayService {
  constructor(
    private readonly locations: DriverLocationService,
    private readonly realtime: RealtimeService,
    private readonly domainEvents: DomainEventsService,
  ) {}

  async handle(driverId: string, fix: DriverLocationFixDto, options: RelayOptions): Promise<LocationIngestResult> {
    const result = await this.locations.ingest(driverId, fix, { enforceRateLimit: options.enforceRateLimit });
    if (!result.accepted) return result;

    if (result.relay) {
      const { location } = result;
      this.realtime.emitVolatileToRide(
        result.relay.rideId,
        {
          event: RideEvent.LOCATION_UPDATED,
          rideId: result.relay.rideId,
          status: result.relay.status,
          timestamp: location.receivedAt.toISOString(),
          // Kept deliberately small: this is the high-frequency event.
          data: {
            driverId,
            latitude: location.latitude,
            longitude: location.longitude,
            heading: location.heading ?? null,
            speed: location.speed ?? null,
            accuracy: location.accuracy ?? null,
            recordedAt: location.recordedAt.toISOString(),
          },
        },
        options.exceptSocketId,
      );
    }

    if (result.arriving) {
      // Fires once per ride (a conditional write in DriverLocationService).
      this.domainEvents.emit("ride.driver_arriving", {
        rideId: result.arriving.rideId,
        driverId,
        etaSeconds: result.arriving.etaSeconds,
        distanceMeters: result.arriving.distanceMeters,
      });
      this.realtime.emitToRide(result.arriving.rideId, {
        event: RideEvent.DRIVER_ARRIVING,
        rideId: result.arriving.rideId,
        status: result.relay?.status,
        timestamp: new Date().toISOString(),
        data: {
          driverId,
          distanceMeters: result.arriving.distanceMeters,
          etaSeconds: result.arriving.etaSeconds,
        },
      });
    }
    return result;
  }
}
