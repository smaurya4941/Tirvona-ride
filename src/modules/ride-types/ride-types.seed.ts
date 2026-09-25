import { VehicleType } from "../vehicles/schemas/vehicle.schema";
import { RideTypeCode } from "./schemas/ride-type.schema";
import type { RideType } from "./schemas/ride-type.schema";

/**
 * Inserted on first boot only (`$setOnInsert`) — once a row exists, admins
 * own it and a redeploy never overwrites their edits.
 */
export const DEFAULT_RIDE_TYPES: Array<Omit<RideType, "isActive"> & { isActive: boolean }> = [
  {
    code: RideTypeCode.BIKE,
    displayName: "Bike",
    description: "Quick, affordable rides for one",
    icon: "bike",
    vehicleType: VehicleType.BIKE,
    seatCapacity: 1,
    sortOrder: 1,
    isActive: true,
  },
  {
    code: RideTypeCode.AUTO,
    displayName: "Auto",
    description: "Everyday auto-rickshaw rides for up to 3",
    icon: "auto",
    vehicleType: VehicleType.AUTO,
    seatCapacity: 3,
    sortOrder: 2,
    isActive: true,
  },
  {
    code: RideTypeCode.CAB,
    displayName: "Cab",
    description: "Comfortable AC cars for up to 4",
    icon: "cab",
    vehicleType: VehicleType.CAB,
    seatCapacity: 4,
    sortOrder: 3,
    isActive: true,
  },
];
