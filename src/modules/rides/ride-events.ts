import { RideEvent } from "../realtime/realtime.constants";
import type { RideEventName } from "../realtime/realtime.constants";
import { DRIVER_ENGAGED_STATUSES, RideStatus, isTerminal } from "./ride-state-machine";

/**
 * What each committed transition means to each participant. Pure, so the
 * whole table is unit-tested without sockets or a database.
 *
 * - `customer`: event for the ride's customer (always informed).
 * - `driver`: event for the ride's current driver, if one is set.
 * - `previousDriver`: event for a driver who just lost the ride's offer.
 * - `closeRoom`: the ride ended; everyone leaves `ride:{id}` afterwards.
 */
export interface RideEventPlan {
  customer: RideEventName;
  driver?: RideEventName;
  previousDriver?: RideEventName;
  closeRoom: boolean;
}

export function planRideEvents(from: RideStatus | undefined, to: RideStatus): RideEventPlan {
  const closeRoom = isTerminal(to);
  switch (to) {
    case RideStatus.SEARCHING:
      return from === RideStatus.DRIVER_ASSIGNED
        ? { customer: RideEvent.SEARCHING, previousDriver: RideEvent.OFFER_WITHDRAWN, closeRoom }
        : { customer: RideEvent.REQUESTED, closeRoom };
    case RideStatus.DRIVER_ASSIGNED:
      // The customer learns a driver was found; the driver receives the offer.
      return { customer: RideEvent.DRIVER_ASSIGNED, driver: RideEvent.REQUESTED, closeRoom };
    case RideStatus.DRIVER_ACCEPTED:
      return { customer: RideEvent.DRIVER_ACCEPTED, driver: RideEvent.DRIVER_ACCEPTED, closeRoom };
    case RideStatus.DRIVER_ARRIVED:
      return { customer: RideEvent.DRIVER_ARRIVED, driver: RideEvent.DRIVER_ARRIVED, closeRoom };
    case RideStatus.RIDE_STARTED:
      return { customer: RideEvent.STARTED, driver: RideEvent.STARTED, closeRoom };
    case RideStatus.COMPLETED:
      return { customer: RideEvent.COMPLETED, driver: RideEvent.COMPLETED, closeRoom };
    case RideStatus.CANCELLED:
      // Includes a driver who was only offered the ride: their card must go.
      return { customer: RideEvent.CANCELLED, driver: RideEvent.CANCELLED, closeRoom };
    case RideStatus.NO_DRIVER_AVAILABLE:
      return { customer: RideEvent.NO_DRIVER_AVAILABLE, closeRoom };
  }
}

/** Whether a participant belongs in `ride:{id}` at this status. */
export function inRideRoom(status: RideStatus, participant: "customer" | "driver"): boolean {
  if (isTerminal(status)) return false;
  return participant === "customer" ? true : DRIVER_ENGAGED_STATUSES.includes(status);
}
