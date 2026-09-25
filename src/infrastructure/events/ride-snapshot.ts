import type { RideDocument } from "../../modules/rides/schemas/ride.schema";
import type { RideSnapshot } from "./domain-events";

export function rideSnapshot(ride: RideDocument): RideSnapshot {
  return {
    rideId: ride._id.toString(),
    rideCode: ride.rideCode,
    status: ride.status,
    stateVersion: ride.stateVersion ?? 0,
    customerId: ride.customerId.toString(),
    driverId: ride.driverId?.toString(),
    driverUserId: ride.driverUserId?.toString(),
    pickupAddress: ride.pickup.address,
    destinationAddress: ride.destination.address,
    finalFare: ride.fare.finalFare,
    estimatedFare: ride.fare.estimatedFare,
    currency: ride.fare.currency,
    cancelledBy: ride.cancellation?.cancelledBy,
    cancellationReason: ride.cancellation?.reason,
  };
}
