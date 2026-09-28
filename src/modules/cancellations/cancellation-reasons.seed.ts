import { RideActorType } from "../rides/ride-state-machine";

export interface ReasonSeed {
  code: string;
  actor: RideActorType;
  label: string;
  requiresNote: boolean;
  sortOrder: number;
}

/** The fallback code used when an older app build sends only free text. */
export const OTHER_REASON_CODE = "OTHER";

/**
 * Starting list from the Phase 7 plan. Inserted once ($setOnInsert); after
 * that ops own the wording and can add, reorder or retire reasons in the
 * admin panel without a release. Codes never change.
 */
export const DEFAULT_CANCELLATION_REASONS: ReasonSeed[] = [
  { code: "CHANGED_MIND", actor: RideActorType.CUSTOMER, label: "Changed my mind", requiresNote: false, sortOrder: 1 },
  { code: "DRIVER_TOO_LONG", actor: RideActorType.CUSTOMER, label: "Driver is taking too long", requiresNote: false, sortOrder: 2 },
  { code: "DRIVER_ASKED_TO_CANCEL", actor: RideActorType.CUSTOMER, label: "Driver asked me to cancel", requiresNote: false, sortOrder: 3 },
  { code: "WRONG_PICKUP", actor: RideActorType.CUSTOMER, label: "Wrong pickup location", requiresNote: false, sortOrder: 4 },
  { code: "BOOKED_BY_MISTAKE", actor: RideActorType.CUSTOMER, label: "Booked by mistake", requiresNote: false, sortOrder: 5 },
  { code: "FOUND_ANOTHER_RIDE", actor: RideActorType.CUSTOMER, label: "Found another ride", requiresNote: false, sortOrder: 6 },
  { code: OTHER_REASON_CODE, actor: RideActorType.CUSTOMER, label: "Other", requiresNote: true, sortOrder: 99 },

  { code: "CUSTOMER_UNREACHABLE", actor: RideActorType.DRIVER, label: "Customer unreachable", requiresNote: false, sortOrder: 1 },
  { code: "UNSAFE_PICKUP", actor: RideActorType.DRIVER, label: "Unsafe pickup", requiresNote: false, sortOrder: 2 },
  { code: "VEHICLE_ISSUE", actor: RideActorType.DRIVER, label: "Vehicle issue", requiresNote: false, sortOrder: 3 },
  { code: "WRONG_LOCATION", actor: RideActorType.DRIVER, label: "Wrong location", requiresNote: false, sortOrder: 4 },
  { code: "EMERGENCY", actor: RideActorType.DRIVER, label: "Emergency", requiresNote: false, sortOrder: 5 },
  { code: OTHER_REASON_CODE, actor: RideActorType.DRIVER, label: "Other", requiresNote: true, sortOrder: 99 },

  { code: "CUSTOMER_REQUEST", actor: RideActorType.ADMIN, label: "Customer asked support to cancel", requiresNote: false, sortOrder: 1 },
  { code: "DRIVER_REQUEST", actor: RideActorType.ADMIN, label: "Driver asked support to cancel", requiresNote: false, sortOrder: 2 },
  { code: "STUCK_RIDE", actor: RideActorType.ADMIN, label: "Ride stuck / technical issue", requiresNote: false, sortOrder: 3 },
  { code: "SAFETY", actor: RideActorType.ADMIN, label: "Safety concern", requiresNote: true, sortOrder: 4 },
  { code: OTHER_REASON_CODE, actor: RideActorType.ADMIN, label: "Other", requiresNote: true, sortOrder: 99 },
];
