import { UserRole } from "../../common/types/user-role.enum";
import type {
  EarningsAdjustedEvent,
  PaymentRefundUpdatedEvent,
  CircuitNoticeEvent,
  RideSnapshot,
  RideTransitionedEvent,
} from "../../infrastructure/events/domain-events";
import { RidePaymentStatus } from "../rides/ride-payment-status";
import { RideActorType, RideStatus } from "../rides/ride-state-machine";
import { NotificationType } from "./notification-types";

/** A notification to create, before it has an id. */
export interface NotificationDraft {
  userId: string;
  recipientRole: UserRole;
  type: NotificationType;
  title: string;
  message: string;
  rideId?: string;
  referenceId?: string;
  data?: Record<string, string>;
  /** Unique per logical notification; replays of the same event are dropped. */
  dedupeKey?: string;
}

export interface RideNotificationContext {
  /** "Rahul" — the driver's first name, when a driver is on the ride. */
  driverName?: string;
  /** "UP85 CC 0001" — shown so the customer can find the vehicle. */
  vehiclePlate?: string;
}

export function formatRupees(amount?: number): string {
  if (amount === undefined || !Number.isFinite(amount)) return "";
  return `₹${Number.isInteger(amount) ? amount : amount.toFixed(2)}`;
}

const shortPlace = (address: string): string =>
  address.split(",")[0]?.trim() || address;

function draft(
  ride: RideSnapshot,
  recipient: { userId: string; role: UserRole },
  type: NotificationType,
  title: string,
  message: string,
  key: string,
): NotificationDraft {
  return {
    userId: recipient.userId,
    recipientRole: recipient.role,
    type,
    title,
    message,
    rideId: ride.rideId,
    data: { rideId: ride.rideId, rideCode: ride.rideCode },
    // One notification per recipient per committed ride state.
    dedupeKey: `ride:${ride.rideId}:${key}:${recipient.userId}`,
  };
}

/**
 * The notification matrix for ride lifecycle events: which participant
 * hears about which transition, and what it says. Pure, so the whole table
 * is unit-tested.
 *
 * WebSocket events keep an open app in sync; these notifications reach a
 * phone in a pocket. The person who caused a change is not notified of it
 * (a customer who cancels is not told "ride cancelled").
 */
export function planRideNotifications(
  event: RideTransitionedEvent,
  context: RideNotificationContext = {},
): NotificationDraft[] {
  const { ride, from, to } = event;
  const customer = { userId: ride.customerId, role: UserRole.CUSTOMER };
  const driver = ride.driverUserId
    ? { userId: ride.driverUserId, role: UserRole.DRIVER }
    : undefined;
  const driverName = context.driverName ?? "Your driver";
  const plate = context.vehiclePlate ? ` (${context.vehiclePlate})` : "";
  const key = `${to}:v${ride.stateVersion}`;
  const drafts: NotificationDraft[] = [];

  switch (to) {
    case RideStatus.SEARCHING:
      // Booking or re-matching: the customer is watching the search screen.
      break;
    case RideStatus.DRIVER_ASSIGNED:
      drafts.push(
        draft(
          ride,
          customer,
          NotificationType.RIDE_DRIVER_ASSIGNED,
          "Driver found",
          `${driverName} has been assigned to your ride and is confirming it.`,
          key,
        ),
      );
      if (driver)
        drafts.push(
          draft(
            ride,
            driver,
            NotificationType.RIDE_REQUEST,
            "New ride request",
            ride.circuitName
              ? `${ride.circuitName}: pickup at ${shortPlace(ride.pickupAddress)} · package ${formatRupees(ride.estimatedFare)}. Respond quickly to accept.`
              : `Pickup at ${shortPlace(ride.pickupAddress)} · ${formatRupees(ride.estimatedFare)}. Respond quickly to accept.`,
            key,
          ),
        );
      break;
    case RideStatus.DRIVER_ACCEPTED:
      drafts.push(
        draft(
          ride,
          customer,
          NotificationType.RIDE_DRIVER_ACCEPTED,
          "Driver on the way",
          `${driverName}${plate} accepted your ride and is heading to ${shortPlace(ride.pickupAddress)}.`,
          key,
        ),
      );
      break;
    case RideStatus.DRIVER_ARRIVED:
      drafts.push(
        draft(
          ride,
          customer,
          NotificationType.RIDE_DRIVER_ARRIVED,
          "Your driver has arrived",
          `${driverName}${plate} is at the pickup point. Share your ride OTP to start.`,
          key,
        ),
      );
      break;
    case RideStatus.RIDE_STARTED:
      drafts.push(
        draft(
          ride,
          customer,
          NotificationType.RIDE_STARTED,
          "Ride started",
          ride.circuitName
            ? `Your ${ride.circuitName} has started. Your included time begins now.`
            : `Your trip to ${shortPlace(ride.destinationAddress)} has started. Have a peaceful journey.`,
          key,
        ),
      );
      if (driver)
        drafts.push(
          draft(
            ride,
            driver,
            NotificationType.RIDE_STARTED,
            "Trip started",
            ride.circuitName
              ? `${ride.circuitName} started. Take the customer to each stop in order.`
              : `Drop the customer at ${shortPlace(ride.destinationAddress)}.`,
            key,
          ),
        );
      break;
    case RideStatus.COMPLETED:
      drafts.push(
        draft(
          ride,
          customer,
          NotificationType.RIDE_COMPLETED,
          "Ride completed",
          ride.circuitName
            ? `${ride.circuitName} is complete. Final fare ${formatRupees(ride.finalFare ?? ride.estimatedFare)} — tap to pay.`
            : `You have arrived. Trip fare ${formatRupees(ride.finalFare ?? ride.estimatedFare)} — tap to pay.`,
          key,
        ),
      );
      if (driver)
        drafts.push(
          draft(
            ride,
            driver,
            NotificationType.RIDE_COMPLETED,
            "Ride completed",
            `Fare ${formatRupees(ride.finalFare ?? ride.estimatedFare)}. Your earnings update once the customer pays.`,
            key,
          ),
        );
      break;
    case RideStatus.CANCELLED: {
      const by = ride.cancelledBy;
      if (by !== RideActorType.CUSTOMER)
        drafts.push(
          draft(
            ride,
            customer,
            NotificationType.RIDE_CANCELLED,
            "Ride cancelled",
            by === RideActorType.DRIVER
              ? "Your driver had to cancel this ride. Please book again."
              : "Your ride has been cancelled.",
            key,
          ),
        );
      // Includes a driver who was only offered the ride (their request card must go).
      if (driver && by !== RideActorType.DRIVER)
        drafts.push(
          draft(
            ride,
            driver,
            NotificationType.RIDE_CANCELLED,
            "Ride cancelled",
            by === RideActorType.CUSTOMER
              ? "The customer cancelled the ride."
              : "This ride has been cancelled.",
            key,
          ),
        );
      break;
    }
    case RideStatus.NO_DRIVER_AVAILABLE:
      if (from !== undefined)
        drafts.push(
          draft(
            ride,
            customer,
            NotificationType.RIDE_NO_DRIVER,
            "No drivers available",
            "All nearby drivers are busy right now. Please try booking again in a few minutes.",
            key,
          ),
        );
      break;
  }
  return drafts;
}

/** `ride.driver_arriving` — once per ride. */
export function planArrivingNotification(
  ride: RideSnapshot,
  etaSeconds: number | undefined,
  context: RideNotificationContext = {},
): NotificationDraft {
  const minutes =
    etaSeconds === undefined
      ? undefined
      : Math.max(1, Math.round(etaSeconds / 60));
  return draft(
    ride,
    { userId: ride.customerId, role: UserRole.CUSTOMER },
    NotificationType.RIDE_DRIVER_ARRIVING,
    "Driver arriving",
    `${context.driverName ?? "Your driver"} is ${minutes ? `about ${minutes} min` : "almost"} away. Please be ready at the pickup point.`,
    "ARRIVING",
  );
}

/**
 * Payment outcomes: the customer is told success/failure, the driver that
 * they were paid — or, for cash, to collect the fare from the customer.
 */
export function planPaymentNotifications(
  ride: RideSnapshot,
  status: RidePaymentStatus,
  amount?: number,
  method?: string,
): NotificationDraft[] {
  const customer = { userId: ride.customerId, role: UserRole.CUSTOMER };
  const money = formatRupees(amount ?? ride.finalFare);
  const key = `PAYMENT_${status}:v${ride.stateVersion}`;
  if (status === RidePaymentStatus.SUCCESS && method === "cash") {
    const drafts = [
      draft(
        ride,
        customer,
        NotificationType.PAYMENT_SUCCESS,
        "Paying in cash",
        `Please hand ${money} in cash to your driver for ride ${ride.rideCode}. Tap to rate your driver.`,
        key,
      ),
    ];
    if (ride.driverUserId)
      drafts.push(
        draft(
          ride,
          { userId: ride.driverUserId, role: UserRole.DRIVER },
          NotificationType.PAYMENT_RECEIVED,
          "Collect cash",
          `The customer is paying ${money} in cash for ride ${ride.rideCode}. Please collect it.`,
          key,
        ),
      );
    return drafts;
  }
  if (status === RidePaymentStatus.SUCCESS) {
    const drafts = [
      draft(
        ride,
        customer,
        NotificationType.PAYMENT_SUCCESS,
        "Payment successful",
        `${money} paid for ride ${ride.rideCode}. Tap to rate your driver.`,
        key,
      ),
    ];
    if (ride.driverUserId)
      drafts.push(
        draft(
          ride,
          { userId: ride.driverUserId, role: UserRole.DRIVER },
          NotificationType.PAYMENT_RECEIVED,
          "Payment received",
          `The customer paid ${money} for ride ${ride.rideCode}. Your earnings are updated.`,
          key,
        ),
      );
    return drafts;
  }
  if (status === RidePaymentStatus.FAILED)
    return [
      draft(
        ride,
        customer,
        NotificationType.PAYMENT_FAILED,
        "Payment failed",
        `Your payment of ${money} for ride ${ride.rideCode} did not go through. Tap to try again.`,
        key,
      ),
    ];
  return [];
}

/**
 * Refund notifications. The customer hears when a refund of their ride
 * payment starts and when Razorpay processes it; a failed refund is an ops
 * matter (the customer is told nothing they cannot act on). Refunds of a
 * duplicate capture use the same wording.
 */
export function planRefundNotifications(
  event: PaymentRefundUpdatedEvent,
): NotificationDraft[] {
  if (!event.changed) return [];
  const money = formatRupees(event.amount);
  const base = {
    userId: event.customerId,
    recipientRole: UserRole.CUSTOMER,
    rideId: event.rideId,
    referenceId: event.paymentId,
    data: {
      rideId: event.rideId,
      rideCode: event.rideCode,
      paymentId: event.paymentId,
      refundId: event.refundId,
    },
  };
  if (event.status === "PENDING")
    return [
      {
        ...base,
        type: NotificationType.REFUND_INITIATED,
        title: "Refund initiated",
        message: `A refund of ${money} for ride ${event.rideCode} is on its way to your original payment method.`,
        dedupeKey: `refund:${event.refundId}:PENDING`,
      },
    ];
  if (event.status === "PROCESSED")
    return [
      {
        ...base,
        type: NotificationType.REFUND_PROCESSED,
        title: "Refund processed",
        message: `${money} for ride ${event.rideCode} has been refunded. Banks usually show it within 5–7 working days.`,
        dedupeKey: `refund:${event.refundId}:PROCESSED`,
      },
    ];
  return [];
}

export function planEarningAdjustedNotification(
  event: EarningsAdjustedEvent,
): NotificationDraft | null {
  if (event.amount <= 0) return null;
  return {
    userId: event.driverUserId,
    recipientRole: UserRole.DRIVER,
    type: NotificationType.EARNING_ADJUSTED,
    title: "Earnings adjusted",
    message: `The customer of ride ${event.rideCode} was refunded ${formatRupees(event.refundAmount)}. ${formatRupees(
      event.amount,
    )} will be deducted from your next payout.`,
    rideId: event.rideId,
    referenceId: event.adjustmentId,
    data: {
      rideId: event.rideId,
      rideCode: event.rideCode,
      adjustmentId: event.adjustmentId,
    },
    dedupeKey: `adjustment:${event.adjustmentId}`,
  };
}

function circuitDraft(
  ride: RideSnapshot,
  recipient: { userId: string; role: UserRole },
  type: NotificationType,
  title: string,
  message: string,
  key: string,
): NotificationDraft {
  return {
    userId: recipient.userId,
    recipientRole: recipient.role,
    type,
    title,
    message,
    rideId: ride.rideId,
    data: { rideId: ride.rideId, rideCode: ride.rideCode, circuit: "1" },
    dedupeKey: `circuit:${ride.rideId}:${key}:${recipient.userId}`,
  };
}

/**
 * Circuit progress and usage warnings. Each fires once per circuit (the
 * dedupe key is the notice itself), for the customer and the driver as
 * their roles need.
 */
export function planCircuitNotifications(
  event: CircuitNoticeEvent,
): NotificationDraft[] {
  const { ride } = event;
  const customer = { userId: ride.customerId, role: UserRole.CUSTOMER };
  const driver = ride.driverUserId
    ? { userId: ride.driverUserId, role: UserRole.DRIVER }
    : undefined;
  const name = ride.circuitName ?? "Your circuit";
  const stop = event.stopName ?? "the stop";
  const key = `${event.kind}:${event.stopOrder ?? 0}`;
  const drafts: NotificationDraft[] = [];
  const both = (
    type: NotificationType,
    title: string,
    customerMessage: string,
    driverMessage = customerMessage,
  ): void => {
    drafts.push(
      circuitDraft(ride, customer, type, title, customerMessage, key),
    );
    if (driver)
      drafts.push(circuitDraft(ride, driver, type, title, driverMessage, key));
  };

  switch (event.kind) {
    case "STOP_ARRIVED":
      drafts.push(
        circuitDraft(
          ride,
          customer,
          NotificationType.CIRCUIT_STOP,
          `Arrived at ${stop}`,
          `You have reached ${stop}. Take your time — your included time keeps running.`,
          key,
        ),
      );
      break;
    case "NEXT_STOP":
      both(
        NotificationType.CIRCUIT_STOP,
        `Next stop: ${event.nextStopName ?? "your next stop"}`,
        `Heading to ${event.nextStopName ?? "the next stop"} next.`,
      );
      break;
    case "STOP_SKIPPED":
      both(
        NotificationType.CIRCUIT_STOP,
        `${stop} skipped`,
        `${stop} was skipped by Tirvona support.${event.nextStopName ? ` Next: ${event.nextStopName}.` : ""}`,
      );
      break;
    case "STOP_BLOCKED":
      both(
        NotificationType.CIRCUIT_EXCEPTION,
        `${stop} is not reachable`,
        `Your driver reported that ${stop} cannot be reached. Tirvona support is looking into it.`,
        `You reported ${stop} as blocked. Support will decide whether to continue or skip it.`,
      );
      break;
    case "EXCEPTION_RESOLVED":
      both(
        NotificationType.CIRCUIT_EXCEPTION,
        "Issue resolved",
        `${name} can continue.`,
      );
      break;
    case "TIME_30_MIN":
      both(
        NotificationType.CIRCUIT_WARNING,
        "30 minutes left",
        `Your included circuit time expires in 30 minutes.`,
        `Circuit package time remaining: 30 minutes.`,
      );
      break;
    case "TIME_10_MIN":
      both(
        NotificationType.CIRCUIT_WARNING,
        "10 minutes left",
        `Your included circuit time expires in 10 minutes. Extra time is charged after that.`,
        `Circuit package time remaining: 10 minutes.`,
      );
      break;
    case "TIME_EXHAUSTED":
      both(
        NotificationType.CIRCUIT_WARNING,
        "Included time used up",
        "Your included time is over. Additional time charges may apply.",
        "Included package time is over. Extra time is now being charged to the customer.",
      );
      break;
    case "DISTANCE_80":
      both(
        NotificationType.CIRCUIT_WARNING,
        "Included distance running low",
        "You have used most of your included distance.",
        "Most of the included package distance is used.",
      );
      break;
    case "DISTANCE_EXHAUSTED":
      both(
        NotificationType.CIRCUIT_WARNING,
        "Included distance used up",
        "Included distance exhausted. Additional distance charges may apply.",
        "Included package distance is exhausted. Extra distance is now being charged.",
      );
      break;
  }
  return drafts;
}
