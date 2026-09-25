import { UserRole } from "../../common/types/user-role.enum";
import {
  ComplaintCategory,
  ComplaintPriority,
  ComplaintStatus,
  canTransitionComplaint,
  categoryAllowed,
  initialPriority,
} from "./complaint-rules";

describe("complaint rules", () => {
  it("customers report drivers, drivers report customers", () => {
    expect(categoryAllowed(UserRole.CUSTOMER, ComplaintCategory.DRIVER_BEHAVIOUR)).toBe(true);
    expect(categoryAllowed(UserRole.CUSTOMER, ComplaintCategory.CUSTOMER_BEHAVIOUR)).toBe(false);
    expect(categoryAllowed(UserRole.DRIVER, ComplaintCategory.CUSTOMER_BEHAVIOUR)).toBe(true);
    expect(categoryAllowed(UserRole.DRIVER, ComplaintCategory.DRIVER_BEHAVIOUR)).toBe(false);
    expect(categoryAllowed(UserRole.DRIVER, ComplaintCategory.PAYMENT)).toBe(true);
  });

  it("safety complaints are urgent from the start", () => {
    expect(initialPriority(ComplaintCategory.SAFETY)).toBe(ComplaintPriority.URGENT);
    expect(initialPriority(ComplaintCategory.FARE)).toBe(ComplaintPriority.MEDIUM);
    expect(initialPriority(ComplaintCategory.TECHNICAL)).toBe(ComplaintPriority.LOW);
  });

  it("workflow: resolved can be reopened for review, closed is final", () => {
    expect(canTransitionComplaint(ComplaintStatus.OPEN, ComplaintStatus.IN_REVIEW)).toBe(true);
    expect(canTransitionComplaint(ComplaintStatus.IN_REVIEW, ComplaintStatus.RESOLVED)).toBe(true);
    expect(canTransitionComplaint(ComplaintStatus.RESOLVED, ComplaintStatus.IN_REVIEW)).toBe(true);
    expect(canTransitionComplaint(ComplaintStatus.RESOLVED, ComplaintStatus.CLOSED)).toBe(true);
    expect(canTransitionComplaint(ComplaintStatus.IN_REVIEW, ComplaintStatus.OPEN)).toBe(false);
    expect(canTransitionComplaint(ComplaintStatus.CLOSED, ComplaintStatus.OPEN)).toBe(false);
  });
});
