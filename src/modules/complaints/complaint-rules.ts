import { UserRole } from "../../common/types/user-role.enum";

export enum ComplaintCategory {
  DRIVER_BEHAVIOUR = "DRIVER_BEHAVIOUR",
  CUSTOMER_BEHAVIOUR = "CUSTOMER_BEHAVIOUR",
  PAYMENT = "PAYMENT",
  FARE = "FARE",
  RIDE_ISSUE = "RIDE_ISSUE",
  SAFETY = "SAFETY",
  LOST_ITEM = "LOST_ITEM",
  TECHNICAL = "TECHNICAL",
  OTHER = "OTHER",
}

export enum ComplaintStatus {
  OPEN = "OPEN",
  IN_REVIEW = "IN_REVIEW",
  RESOLVED = "RESOLVED",
  CLOSED = "CLOSED",
}

export enum ComplaintPriority {
  LOW = "LOW",
  MEDIUM = "MEDIUM",
  HIGH = "HIGH",
  URGENT = "URGENT",
}

export const OPEN_COMPLAINT_STATUSES: readonly ComplaintStatus[] = [ComplaintStatus.OPEN, ComplaintStatus.IN_REVIEW];

/**
 * Support workflow. RESOLVED can be reopened for review (the user came
 * back); CLOSED is final.
 */
export const COMPLAINT_TRANSITIONS: Readonly<Record<ComplaintStatus, readonly ComplaintStatus[]>> = {
  [ComplaintStatus.OPEN]: [ComplaintStatus.IN_REVIEW, ComplaintStatus.RESOLVED, ComplaintStatus.CLOSED],
  [ComplaintStatus.IN_REVIEW]: [ComplaintStatus.RESOLVED, ComplaintStatus.CLOSED],
  [ComplaintStatus.RESOLVED]: [ComplaintStatus.IN_REVIEW, ComplaintStatus.CLOSED],
  [ComplaintStatus.CLOSED]: [],
};

export const canTransitionComplaint = (from: ComplaintStatus, to: ComplaintStatus): boolean =>
  COMPLAINT_TRANSITIONS[from].includes(to);

/** Which categories each role may file (a customer reports drivers, and vice versa). */
export function categoryAllowed(role: UserRole, category: ComplaintCategory): boolean {
  if (category === ComplaintCategory.DRIVER_BEHAVIOUR) return role === UserRole.CUSTOMER;
  if (category === ComplaintCategory.CUSTOMER_BEHAVIOUR) return role === UserRole.DRIVER;
  return true;
}

/** Categories that are about a specific trip and need a ride attached. */
export const RIDE_REQUIRED_CATEGORIES: readonly ComplaintCategory[] = [
  ComplaintCategory.DRIVER_BEHAVIOUR,
  ComplaintCategory.CUSTOMER_BEHAVIOUR,
  ComplaintCategory.FARE,
  ComplaintCategory.RIDE_ISSUE,
  ComplaintCategory.LOST_ITEM,
];

/** Initial triage; admins may change it. Safety is never left in the queue. */
export function initialPriority(category: ComplaintCategory): ComplaintPriority {
  switch (category) {
    case ComplaintCategory.SAFETY:
      return ComplaintPriority.URGENT;
    case ComplaintCategory.DRIVER_BEHAVIOUR:
    case ComplaintCategory.CUSTOMER_BEHAVIOUR:
    case ComplaintCategory.PAYMENT:
    case ComplaintCategory.LOST_ITEM:
      return ComplaintPriority.HIGH;
    case ComplaintCategory.TECHNICAL:
    case ComplaintCategory.OTHER:
      return ComplaintPriority.LOW;
    default:
      return ComplaintPriority.MEDIUM;
  }
}
