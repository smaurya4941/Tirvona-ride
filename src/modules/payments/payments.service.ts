import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectModel } from "@nestjs/mongoose";
import type { Model, QueryFilter, UpdateQuery } from "mongoose";
import { Types } from "mongoose";
import { ApiException, apiBadRequest, apiNotFound } from "../../common/exceptions/api.exception";
import { toPaise, toRupees } from "../../common/utils/money";
import { DriverProfile } from "../drivers/schemas/driver-profile.schema";
import { EarningsService } from "../earnings/earnings.service";
import { RidePaymentStateService } from "../rides/ride-payment-state.service";
import {
  PAID_RIDE_PAYMENT_STATUSES,
  PAYABLE_RIDE_PAYMENT_STATUSES,
  RidePaymentStatus,
  effectivePaymentStatus,
} from "../rides/ride-payment-status";
import { RideStatus } from "../rides/ride-state-machine";
import type { RideDocument } from "../rides/schemas/ride.schema";
import { User } from "../users/schemas/user.schema";
import type { PaymentFailureDto, PaymentHistoryQueryDto, VerifyPaymentDto } from "./dto/payment.dto";
import {
  OPEN_PAYMENT_STATUSES,
  PAYMENT_GATEWAY,
  PaymentAttemptStatus,
  PaymentEventSource,
  PaymentStatus,
  SETTLED_PAYMENT_STATUSES,
} from "./interfaces/payment-status";
import type {
  CheckoutView,
  PaymentHistoryItem,
  PaymentReceiptView,
  PaymentView,
} from "./interfaces/payment-views";
import { RazorpayGateway, RazorpayGatewayError } from "./razorpay/razorpay.gateway";
import { verifyPaymentSignature } from "./razorpay/razorpay-signature";
import type { RazorpayPayment } from "./razorpay/razorpay.types";
import { Payment } from "./schemas/payment.schema";
import type { PaymentAttempt, PaymentDocument, PaymentEvent } from "./schemas/payment.schema";

// Razorpay's smallest chargeable amount (₹1).
const MIN_AMOUNT_PAISE = 100;
const ORDER_LOCK_MS = 15_000;
const ORDER_LOCK_WAIT_MS = 8_000;
// GET /payments/:id re-checks an unfinished payment with Razorpay at most this often.
const READ_RECONCILE_INTERVAL_MS = 10_000;
const MAX_EVENTS = 100;

const isDuplicateKey = (error: unknown, index?: string): boolean => {
  const mongoError = error as { code?: number; message?: string } | undefined;
  return mongoError?.code === 11000 && (!index || (mongoError.message ?? "").includes(index));
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const nameOf = (user?: { firstName?: string; lastName?: string } | null): string =>
  [user?.firstName, user?.lastName].filter(Boolean).join(" ");

/**
 * Ride payments with Razorpay Standard Checkout.
 *
 * NestJS is the business authority: it decides the amount (the ride's final
 * fare), creates the order, and alone decides a payment succeeded — after
 * checking the checkout signature and asking Razorpay itself. The app's
 * success callback is a hint that triggers verification, never proof.
 *
 * Every path that can settle a payment (/verify, the webhook, the
 * reconciler) funnels into `applyGatewayPayment`, whose writes are
 * compare-and-set on the payment's status. Duplicate verifies and repeated
 * webhooks therefore converge on one CAPTURED payment, one SUCCESS ride and
 * one earning.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private readonly keySecret: string;
  private readonly brandName: string;
  private readonly orderReuseMs: number;

  constructor(
    @InjectModel(Payment.name) private readonly paymentModel: Model<Payment>,
    @InjectModel(User.name) private readonly userModel: Model<User>,
    @InjectModel(DriverProfile.name) private readonly driverModel: Model<DriverProfile>,
    private readonly gateway: RazorpayGateway,
    private readonly rides: RidePaymentStateService,
    private readonly earnings: EarningsService,
    config: ConfigService,
  ) {
    this.keySecret = config.get<string>("razorpayKeySecret") ?? "";
    this.brandName = config.getOrThrow<string>("paymentBrandName");
    this.orderReuseMs = config.getOrThrow<number>("paymentOrderReuseMinutes") * 60_000;
  }

  // ── Customer: start / retry ───────────────────────────────────────────

  /**
   * "Create payment for this ride." Validates ownership, completion and the
   * unpaid state, then returns a checkout for the server-calculated final
   * fare — re-using the open Razorpay order when there is one, so retries
   * and double taps never pile up orders or payment records.
   */
  async create(customerUserId: string, rideId: string): Promise<CheckoutView> {
    this.assertGateway();
    const ride = await this.rides.findForCustomer(customerUserId, rideId);
    const amountPaise = this.payableAmount(ride);
    let payment = await this.findOrCreateForRide(ride, amountPaise);

    if (SETTLED_PAYMENT_STATUSES.includes(payment.status)) {
      await this.afterCapture(payment);
      throw this.alreadyPaid(payment);
    }

    // Razorpay may already hold a payment for this ride that we have not
    // confirmed. Resolve that first: a new order now could charge twice.
    if (payment.processingPaymentId || effectivePaymentStatus(ride) === RidePaymentStatus.PROCESSING) {
      payment = await this.reconcile(payment, PaymentEventSource.SYSTEM);
      if (SETTLED_PAYMENT_STATUSES.includes(payment.status)) throw this.alreadyPaid(payment);
      if (payment.processingPaymentId)
        throw new ApiException(
          HttpStatus.CONFLICT,
          "We are still confirming your earlier payment. Please check again in a minute.",
          "PAYMENT_IN_PROGRESS",
          { paymentId: payment._id.toString() },
        );
    }

    const opened = await this.openAttempt(payment, amountPaise);
    payment = opened.payment;
    await this.rides.apply({
      rideId: ride._id,
      from: [RidePaymentStatus.PENDING, RidePaymentStatus.FAILED],
      to: RidePaymentStatus.ORDER_CREATED,
      payment: { paymentId: payment._id, amount: toRupees(amountPaise) },
      clear: ["failureReason"],
    });
    return this.toCheckout(payment, opened.attempt, customerUserId);
  }

  // ── Customer: verify the checkout result ──────────────────────────────

  /**
   * Verification rules, in order:
   *  1–3. the order belongs to this Tirvona payment, whose ride and customer
   *       are the caller's (lookup is scoped to the customer);
   *  5.   the checkout signature is valid for (order, payment);
   *  6/7. an already-successful payment is returned as-is (idempotent);
   *  8.   the Razorpay payment is not attached to any other ride;
   *  4.   Razorpay confirms the payment belongs to the order and the amount
   *       and currency equal the ride's final fare — then it is captured.
   */
  async verify(customerUserId: string, dto: VerifyPaymentDto): Promise<PaymentView> {
    this.assertGateway();
    let payment = await this.findForCustomer(customerUserId, dto.paymentId);

    const attempt = payment.attempts.find((entry) => entry.orderId === dto.razorpayOrderId);
    if (!attempt)
      throw apiBadRequest("This payment does not belong to this ride", "PAYMENT_ORDER_MISMATCH");

    if (!verifyPaymentSignature(dto.razorpayOrderId, dto.razorpayPaymentId, dto.razorpaySignature, this.keySecret)) {
      await this.pushEvent(payment._id, {
        type: "SIGNATURE_INVALID",
        source: PaymentEventSource.VERIFY,
        razorpayOrderId: dto.razorpayOrderId,
        razorpayPaymentId: dto.razorpayPaymentId,
      });
      this.logger.warn(`Invalid checkout signature for payment ${payment._id.toString()}`);
      throw apiBadRequest("Payment verification failed", "PAYMENT_SIGNATURE_INVALID");
    }

    // Idempotent fast path: the same success reported again.
    if (SETTLED_PAYMENT_STATUSES.includes(payment.status) && payment.razorpayPaymentId === dto.razorpayPaymentId) {
      await this.afterCapture(payment);
      return this.view(payment);
    }

    const reused = await this.paymentModel
      .exists({ razorpayPaymentId: dto.razorpayPaymentId, _id: { $ne: payment._id } })
      .exec();
    if (reused) throw new ApiException(HttpStatus.CONFLICT, "This payment was already used", "PAYMENT_ID_REUSED");

    let gatewayPayment: RazorpayPayment;
    try {
      gatewayPayment = await this.gateway.fetchPayment(dto.razorpayPaymentId);
    } catch (error) {
      if (error instanceof RazorpayGatewayError && error.transient && OPEN_PAYMENT_STATUSES.includes(payment.status)) {
        // The signature proves Razorpay issued this payment for our order,
        // but we could not confirm its state. Park it; the webhook or the
        // reconciler finishes the job. The app shows "confirming payment".
        payment = await this.markProcessing(
          payment,
          dto.razorpayOrderId,
          dto.razorpayPaymentId,
          PaymentEventSource.VERIFY,
          "Razorpay unreachable during verification",
        );
        return this.view(payment);
      }
      throw this.gatewayFailure(error, "Could not verify the payment. Please try again.");
    }

    payment = await this.applyGatewayPayment(payment, gatewayPayment, PaymentEventSource.VERIFY, dto.razorpaySignature);
    if (SETTLED_PAYMENT_STATUSES.includes(payment.status) && payment.razorpayPaymentId !== dto.razorpayPaymentId)
      throw this.alreadyPaid(payment);
    return this.view(payment);
  }

  /**
   * The checkout failed or was dismissed. Advisory: moves an unpaid ride to
   * FAILED so the app can offer "Try again", but never overrides a payment
   * Razorpay is still processing or has captured.
   */
  async reportFailure(customerUserId: string, paymentId: string, dto: PaymentFailureDto): Promise<PaymentView> {
    const payment = await this.findForCustomer(customerUserId, paymentId);
    if (!OPEN_PAYMENT_STATUSES.includes(payment.status) || payment.processingPaymentId) {
      await this.pushEvent(payment._id, {
        type: "CLIENT_FAILURE_IGNORED",
        source: PaymentEventSource.CUSTOMER,
        razorpayOrderId: dto.razorpayOrderId,
        razorpayPaymentId: dto.razorpayPaymentId,
        detail: dto.description,
      });
      return this.view(payment);
    }
    const knownOrder = payment.attempts.some((attempt) => attempt.orderId === dto.razorpayOrderId)
      ? dto.razorpayOrderId
      : undefined;
    const updated = await this.settleFailed(payment, {
      orderId: knownOrder,
      razorpayPaymentId: dto.razorpayPaymentId,
      code: dto.code ?? (dto.cancelled ? "PAYMENT_CANCELLED" : "PAYMENT_FAILED"),
      reason: dto.cancelled ? "Payment was cancelled" : dto.description || "Payment failed",
      source: PaymentEventSource.CUSTOMER,
      fromClient: true,
    });
    return this.view(updated);
  }

  // ── Customer reads ────────────────────────────────────────────────────

  async receipt(customerUserId: string, paymentId: string): Promise<PaymentReceiptView> {
    let payment = await this.findForCustomer(customerUserId, paymentId);
    // Opportunistic sync: an app returning from checkout after being killed
    // finds its payment settled here even before the webhook arrives.
    if (
      this.gateway.isConfigured &&
      OPEN_PAYMENT_STATUSES.includes(payment.status) &&
      payment.attempts.length > 0 &&
      (!payment.lastReconciledAt || Date.now() - payment.lastReconciledAt.getTime() > READ_RECONCILE_INTERVAL_MS)
    )
      payment = await this.reconcile(payment, PaymentEventSource.RECONCILE);

    const ride = await this.rides.findById(payment.rideId);
    const [customer, driverProfile] = await Promise.all([
      this.userModel.findById(payment.customerId).select("firstName lastName phone").lean().exec(),
      this.driverModel.findById(payment.driverId).select("userId").lean().exec(),
    ]);
    const driverUser = driverProfile
      ? await this.userModel.findById(driverProfile.userId).select("firstName lastName").lean().exec()
      : null;

    const view = this.view(payment, ride ?? undefined);
    return {
      ...view,
      ride: ride
        ? {
            id: ride._id.toString(),
            rideCode: ride.rideCode,
            rideType: ride.rideType,
            pickup: { address: ride.pickup.address, latitude: ride.pickup.latitude, longitude: ride.pickup.longitude },
            destination: {
              address: ride.destination.address,
              latitude: ride.destination.latitude,
              longitude: ride.destination.longitude,
            },
            distanceMeters: ride.distanceMeters,
            durationSeconds: ride.durationSeconds,
            requestedAt: ride.requestedAt,
            startedAt: ride.startedAt,
            completedAt: ride.completedAt,
            fare: {
              currency: ride.fare.currency,
              baseFare: ride.fare.baseFare,
              distanceCharge: ride.fare.distanceCharge,
              timeCharge: ride.fare.timeCharge,
              subtotal: ride.fare.subtotal,
              minimumFare: ride.fare.minimumFare,
              minimumFareApplied: ride.fare.minimumFareApplied,
              estimatedFare: ride.fare.estimatedFare,
              finalFare: ride.fare.finalFare,
            },
          }
        : {
            id: payment.rideId.toString(),
            rideCode: payment.rideCode,
            rideType: "",
            pickup: { address: "", latitude: 0, longitude: 0 },
            destination: { address: "", latitude: 0, longitude: 0 },
            distanceMeters: 0,
            durationSeconds: 0,
            requestedAt: payment.get("createdAt") as Date,
            fare: {
              currency: payment.currency,
              baseFare: 0,
              distanceCharge: 0,
              timeCharge: 0,
              subtotal: toRupees(payment.amountPaise),
              minimumFare: 0,
              minimumFareApplied: false,
              estimatedFare: toRupees(payment.amountPaise),
              finalFare: toRupees(payment.amountPaise),
            },
          },
      customer: { name: nameOf(customer) || "Customer", phone: customer?.phone },
      driver: driverUser ? { name: nameOf(driverUser) || "Driver" } : null,
      vehicle: ride?.vehicle
        ? {
            vehicleType: ride.vehicle.vehicleType,
            registrationNumber: ride.vehicle.registrationNumber,
            make: ride.vehicle.make,
            model: ride.vehicle.model,
            color: ride.vehicle.color,
          }
        : null,
    };
  }

  async history(
    customerUserId: string,
    query: PaymentHistoryQueryDto,
  ): Promise<{ items: PaymentHistoryItem[]; page: number; limit: number; total: number; hasMore: boolean }> {
    const filter: QueryFilter<Payment> = { customerId: new Types.ObjectId(customerUserId) };
    if (query.status) filter.status = query.status;
    const [payments, total] = await Promise.all([
      this.paymentModel
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .exec(),
      this.paymentModel.countDocuments(filter).exec(),
    ]);
    const rides = await this.rides.findManyByIds(payments.map((payment) => payment.rideId));
    const rideById = new Map(rides.map((ride) => [ride._id.toString(), ride]));
    return {
      items: payments.map((payment) => {
        const ride = rideById.get(payment.rideId.toString());
        return {
          ...this.view(payment, ride),
          rideType: ride?.rideType,
          pickupAddress: ride?.pickup.address,
          destinationAddress: ride?.destination.address,
          rideCompletedAt: ride?.completedAt,
        };
      }),
      page: query.page,
      limit: query.limit,
      total,
      hasMore: query.page * query.limit < total,
    };
  }

  // ── Settlement (shared by verify, webhook and reconciler) ─────────────

  /**
   * Applies what Razorpay says about one of its payments to our record.
   * Throws PAYMENT_ORDER_MISMATCH / PAYMENT_AMOUNT_MISMATCH when Razorpay's
   * facts disagree with ours — such a payment is never marked successful.
   */
  async applyGatewayPayment(
    payment: PaymentDocument,
    gatewayPayment: RazorpayPayment,
    source: PaymentEventSource,
    signature?: string,
  ): Promise<PaymentDocument> {
    const attempt = payment.attempts.find((entry) => entry.orderId === gatewayPayment.order_id);
    if (!attempt) {
      await this.pushEvent(payment._id, {
        type: "ORDER_MISMATCH",
        source,
        razorpayOrderId: gatewayPayment.order_id ?? undefined,
        razorpayPaymentId: gatewayPayment.id,
      });
      throw apiBadRequest("This payment does not belong to this ride", "PAYMENT_ORDER_MISMATCH");
    }
    if (
      gatewayPayment.amount !== attempt.amountPaise ||
      gatewayPayment.amount !== payment.amountPaise ||
      gatewayPayment.currency !== payment.currency
    ) {
      await this.pushEvent(payment._id, {
        type: "AMOUNT_MISMATCH",
        source,
        razorpayOrderId: attempt.orderId,
        razorpayPaymentId: gatewayPayment.id,
        detail: `gateway ${gatewayPayment.amount} ${gatewayPayment.currency}, expected ${payment.amountPaise} ${payment.currency}`,
      });
      this.logger.error(
        `Amount mismatch on payment ${payment._id.toString()}: Razorpay ${gatewayPayment.amount} ${gatewayPayment.currency}, ` +
          `expected ${payment.amountPaise} ${payment.currency}`,
      );
      throw apiBadRequest("The paid amount does not match the ride fare", "PAYMENT_AMOUNT_MISMATCH");
    }

    // Already settled by another payment on this ride.
    if (SETTLED_PAYMENT_STATUSES.includes(payment.status)) {
      if (payment.razorpayPaymentId === gatewayPayment.id) {
        if (gatewayPayment.status === "refunded" || (gatewayPayment.amount_refunded ?? 0) > 0)
          return this.recordRefund(payment, {
            amountPaise: gatewayPayment.amount_refunded ?? gatewayPayment.amount,
            status: "processed",
            source,
          });
        await this.afterCapture(payment);
        return payment;
      }
      if (gatewayPayment.status === "captured" || gatewayPayment.status === "refunded")
        await this.recordDuplicate(payment, gatewayPayment, source);
      else if (gatewayPayment.status === "authorized")
        // Deliberately not captured: Razorpay auto-refunds an uncaptured
        // authorisation, so the customer is never charged twice.
        await this.pushEvent(payment._id, {
          type: "DUPLICATE_AUTHORIZATION_LEFT_UNCAPTURED",
          source,
          razorpayOrderId: gatewayPayment.order_id ?? undefined,
          razorpayPaymentId: gatewayPayment.id,
        });
      return payment;
    }

    switch (gatewayPayment.status) {
      case "captured":
        return this.settleCaptured(payment, gatewayPayment, source, signature);
      case "refunded": {
        const captured = await this.settleCaptured(payment, gatewayPayment, source, signature);
        return this.recordRefund(captured, {
          amountPaise: gatewayPayment.amount_refunded ?? gatewayPayment.amount,
          status: "processed",
          source,
        });
      }
      case "authorized": {
        try {
          const captured = await this.gateway.capturePayment(gatewayPayment.id, payment.amountPaise, payment.currency);
          return this.settleCaptured(payment, captured, source, signature);
        } catch (error) {
          // "already captured" (auto-capture raced us) → re-read and settle.
          try {
            const latest = await this.gateway.fetchPayment(gatewayPayment.id);
            if (latest.status === "captured") return this.settleCaptured(payment, latest, source, signature);
          } catch {
            // fall through to PROCESSING
          }
          this.logger.warn(
            `Capture of ${gatewayPayment.id} failed (${(error as Error).message}); left PROCESSING for the reconciler`,
          );
          return this.markProcessing(
            payment,
            attempt.orderId,
            gatewayPayment.id,
            source,
            "Authorised; capture pending",
            true,
          );
        }
      }
      case "failed":
        return this.settleFailed(payment, {
          orderId: attempt.orderId,
          razorpayPaymentId: gatewayPayment.id,
          code: gatewayPayment.error_code ?? "PAYMENT_FAILED",
          reason: gatewayPayment.error_description || "Payment failed",
          source,
        });
      case "created":
        return this.markProcessing(payment, attempt.orderId, gatewayPayment.id, source, "Payment created at Razorpay");
    }
  }

  /**
   * Asks Razorpay what happened to this payment's open orders and applies
   * it. Used for stuck PROCESSING payments, receipts, and before opening a
   * new order. Never throws for gateway trouble — it just tries later.
   */
  async reconcile(payment: PaymentDocument, source: PaymentEventSource): Promise<PaymentDocument> {
    if (!this.gateway.isConfigured || !OPEN_PAYMENT_STATUSES.includes(payment.status)) return payment;

    const orderIds = [...payment.attempts]
      .filter((attempt) => attempt.status !== PaymentAttemptStatus.PAID)
      .reverse()
      .slice(0, 3)
      .map((attempt) => attempt.orderId);
    const seen: RazorpayPayment[] = [];
    try {
      for (const orderId of orderIds) seen.push(...(await this.gateway.fetchOrderPayments(orderId)));
    } catch (error) {
      this.logger.warn(`Reconcile of payment ${payment._id.toString()} deferred: ${(error as Error).message}`);
      return payment;
    }
    // Stamped only once Razorpay answered, so a failed attempt never delays the next one.
    await this.paymentModel.updateOne({ _id: payment._id }, { $set: { lastReconciledAt: new Date() } }).exec();

    try {
      const settled =
        seen.find((entry) => entry.status === "captured" || entry.status === "refunded") ??
        seen.find((entry) => entry.status === "authorized");
      if (settled) return await this.applyGatewayPayment(payment, settled, source);

      const inFlight = payment.processingPaymentId
        ? seen.find((entry) => entry.id === payment.processingPaymentId)
        : undefined;
      if (inFlight && inFlight.status === "failed") return await this.applyGatewayPayment(payment, inFlight, source);
    } catch (error) {
      this.logger.error(
        `Reconcile of payment ${payment._id.toString()} flagged: ${(error as Error).message}`,
      );
    }
    return (await this.paymentModel.findById(payment._id).exec()) ?? payment;
  }

  /** Ride → SUCCESS and the earning line, both idempotent. Safe to repeat. */
  async afterCapture(payment: PaymentDocument): Promise<void> {
    if (payment.status !== PaymentStatus.CAPTURED) return;
    await this.rides.apply({
      rideId: payment.rideId,
      from: [
        RidePaymentStatus.PENDING,
        RidePaymentStatus.ORDER_CREATED,
        RidePaymentStatus.PROCESSING,
        RidePaymentStatus.FAILED,
      ],
      to: RidePaymentStatus.SUCCESS,
      payment: {
        paymentId: payment._id,
        gatewayPaymentId: payment.razorpayPaymentId,
        method: payment.method,
        amount: toRupees(payment.amountPaise),
        paidAt: payment.paidAt,
      },
      clear: ["failureReason"],
    });
    await this.ensureEarning(payment);
  }

  /** Creates the ride's earning line if it is missing (reconciler retries on failure). */
  async ensureEarning(payment: PaymentDocument): Promise<void> {
    if (payment.earningId) return;
    try {
      const ride = await this.rides.findById(payment.rideId);
      if (!ride?.completedAt) {
        this.logger.error(`Payment ${payment._id.toString()} is captured but its ride is missing or not completed`);
        return;
      }
      const { earning } = await this.earnings.recordForPayment({
        paymentId: payment._id,
        rideId: ride._id,
        driverId: payment.driverId,
        driverUserId: payment.driverUserId,
        rideCode: ride.rideCode,
        rideType: ride.rideType,
        pickupAddress: ride.pickup.address,
        destinationAddress: ride.destination.address,
        rideCompletedAt: ride.completedAt,
        // The captured amount *is* the final fare (checked against it above).
        grossFarePaise: payment.amountPaise,
        currency: payment.currency,
      });
      await this.paymentModel
        .updateOne({ _id: payment._id, earningId: { $exists: false } }, { $set: { earningId: earning._id } })
        .exec();
      payment.earningId = earning._id;
    } catch (error) {
      this.logger.error(
        `Earning for payment ${payment._id.toString()} not recorded yet (will retry)`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /** Payments captured but with no earning line yet (reconciler). */
  async findCapturedWithoutEarning(limit: number): Promise<PaymentDocument[]> {
    return this.paymentModel
      .find({ status: PaymentStatus.CAPTURED, earningId: { $exists: false } })
      .limit(limit)
      .exec();
  }

  /** Payments Razorpay may have settled without telling us yet (reconciler). */
  async findStaleProcessing(olderThan: Date, limit: number): Promise<PaymentDocument[]> {
    return this.paymentModel
      .find({
        status: { $in: [PaymentStatus.CREATED, PaymentStatus.AUTHORIZED] },
        processingSince: { $lte: olderThan },
        $or: [{ lastReconciledAt: { $exists: false } }, { lastReconciledAt: { $lte: olderThan } }],
      })
      .sort({ processingSince: 1 })
      .limit(limit)
      .exec();
  }

  async findById(paymentId: string): Promise<PaymentDocument | null> {
    return this.paymentModel.findById(paymentId).exec();
  }

  async findByOrderId(orderId: string): Promise<PaymentDocument | null> {
    return this.paymentModel.findOne({ "attempts.orderId": orderId }).exec();
  }

  async findByRazorpayPaymentId(razorpayPaymentId: string): Promise<PaymentDocument | null> {
    return this.paymentModel
      .findOne({
        $or: [{ razorpayPaymentId }, { "attempts.razorpayPaymentId": razorpayPaymentId }, { processingPaymentId: razorpayPaymentId }],
      })
      .exec();
  }

  /** Refund synced from Razorpay (V1 has no refund workflow of its own). */
  async recordRefund(
    payment: PaymentDocument,
    refund: { refundId?: string; amountPaise: number; status: string; source: PaymentEventSource },
  ): Promise<PaymentDocument> {
    if (!SETTLED_PAYMENT_STATUSES.includes(payment.status)) return payment;
    const processed = refund.status === "processed";
    const amountPaise = Math.min(refund.amountPaise, payment.amountPaise);
    const full = amountPaise >= payment.amountPaise;
    const status = !processed
      ? payment.status
      : full
        ? PaymentStatus.REFUNDED
        : PaymentStatus.PARTIALLY_REFUNDED;
    const updated = await this.paymentModel
      .findOneAndUpdate(
        { _id: payment._id },
        {
          $set: {
            status,
            refundId: refund.refundId ?? payment.refundId,
            refundAmountPaise: amountPaise,
            refundStatus: refund.status,
            ...(processed ? { refundedAt: new Date() } : {}),
          },
          $push: {
            events: {
              $each: [
                {
                  type: `REFUND_${refund.status.toUpperCase()}`,
                  source: refund.source,
                  at: new Date(),
                  razorpayPaymentId: payment.razorpayPaymentId,
                  detail: `${amountPaise} paise${refund.refundId ? ` (${refund.refundId})` : ""}`,
                },
              ],
              $slice: -MAX_EVENTS,
            },
          },
        },
        { returnDocument: "after" },
      )
      .exec();
    if (processed) {
      await this.rides.apply({
        rideId: payment.rideId,
        from: [RidePaymentStatus.SUCCESS, RidePaymentStatus.PARTIALLY_REFUNDED],
        to: full ? RidePaymentStatus.REFUNDED : RidePaymentStatus.PARTIALLY_REFUNDED,
      });
      // The earning line is immutable and V1 has no clawback: flag it.
      this.logger.warn(
        `Payment ${payment._id.toString()} refunded ${amountPaise}p — review driver earning ${payment.earningId?.toString() ?? "(none)"} before payout`,
      );
    }
    return updated ?? payment;
  }

  // ── Internals ─────────────────────────────────────────────────────────

  private payableAmount(ride: RideDocument): number {
    if (ride.status !== RideStatus.COMPLETED)
      throw new ApiException(
        HttpStatus.CONFLICT,
        "Payment opens once the ride is completed",
        "PAYMENT_RIDE_NOT_COMPLETED",
        { rideStatus: ride.status },
      );
    const status = effectivePaymentStatus(ride);
    if (PAID_RIDE_PAYMENT_STATUSES.includes(status))
      throw new ApiException(HttpStatus.CONFLICT, "This ride is already paid", "PAYMENT_ALREADY_COMPLETED", {
        paymentId: ride.payment?.paymentId.toString(),
        paymentStatus: status,
      });
    if (!PAYABLE_RIDE_PAYMENT_STATUSES.includes(status) || !ride.driverId || !ride.driverUserId)
      throw new ApiException(HttpStatus.CONFLICT, "This ride has nothing to pay", "PAYMENT_NOT_PAYABLE", {
        paymentStatus: status,
      });
    const fare = ride.fare.finalFare;
    if (fare === undefined || toPaise(fare) < MIN_AMOUNT_PAISE)
      throw new ApiException(
        HttpStatus.CONFLICT,
        "The final fare for this ride is not available",
        "PAYMENT_FARE_UNAVAILABLE",
      );
    return toPaise(fare);
  }

  private async findOrCreateForRide(ride: RideDocument, amountPaise: number): Promise<PaymentDocument> {
    const existing = await this.paymentModel.findOne({ rideId: ride._id }).exec();
    if (existing) {
      // The final fare is frozen at completion; this only heals a record
      // created before an ops correction, and never touches a paid one.
      if (existing.amountPaise !== amountPaise && OPEN_PAYMENT_STATUSES.includes(existing.status)) {
        const healed = await this.paymentModel
          .findOneAndUpdate(
            { _id: existing._id, status: { $in: OPEN_PAYMENT_STATUSES } },
            { $set: { amountPaise } },
            { returnDocument: "after" },
          )
          .exec();
        return healed ?? existing;
      }
      return existing;
    }
    try {
      return await this.paymentModel.create({
        rideId: ride._id,
        rideCode: ride.rideCode,
        customerId: ride.customerId,
        driverId: ride.driverId,
        driverUserId: ride.driverUserId,
        gateway: PAYMENT_GATEWAY,
        amountPaise,
        currency: ride.fare.currency || "INR",
        status: PaymentStatus.CREATED,
        events: [{ type: "PAYMENT_OPENED", source: PaymentEventSource.CUSTOMER, at: new Date() }],
      });
    } catch (error) {
      if (!isDuplicateKey(error, "uniq_payment_per_ride")) throw error;
      const winner = await this.paymentModel.findOne({ rideId: ride._id }).exec();
      if (!winner) throw error;
      return winner;
    }
  }

  /** Re-uses the open order, or raises a new one under a short per-payment lock. */
  private async openAttempt(
    initial: PaymentDocument,
    amountPaise: number,
  ): Promise<{ payment: PaymentDocument; attempt: PaymentAttempt }> {
    let payment = initial;
    const reusable = (candidate: PaymentDocument): PaymentAttempt | undefined => {
      const latest = candidate.attempts[candidate.attempts.length - 1];
      if (!latest || latest.status === PaymentAttemptStatus.PAID || latest.amountPaise !== amountPaise) return undefined;
      const createdAt = latest.createdAt?.getTime() ?? 0;
      return Date.now() - createdAt < this.orderReuseMs ? latest : undefined;
    };

    const existing = reusable(payment);
    if (existing) return { payment: await this.reopen(payment, existing), attempt: existing };

    // Serialise order creation: a double tap must not raise two orders.
    const waitUntil = Date.now() + ORDER_LOCK_WAIT_MS;
    for (;;) {
      const locked = await this.paymentModel
        .findOneAndUpdate(
          {
            _id: payment._id,
            status: { $in: OPEN_PAYMENT_STATUSES },
            $or: [{ orderLockUntil: { $exists: false } }, { orderLockUntil: { $lte: new Date() } }],
          },
          { $set: { orderLockUntil: new Date(Date.now() + ORDER_LOCK_MS) } },
          { returnDocument: "after" },
        )
        .exec();
      if (locked) {
        payment = locked;
        break;
      }
      await sleep(200);
      const latest = await this.paymentModel.findById(payment._id).exec();
      if (!latest) throw apiNotFound("Payment not found", "PAYMENT_NOT_FOUND");
      if (SETTLED_PAYMENT_STATUSES.includes(latest.status)) throw this.alreadyPaid(latest);
      const raised = reusable(latest);
      if (raised) return { payment: await this.reopen(latest, raised), attempt: raised };
      if (Date.now() > waitUntil)
        throw new ApiException(
          HttpStatus.CONFLICT,
          "A payment for this ride is being prepared. Please try again.",
          "PAYMENT_IN_PROGRESS",
        );
      payment = latest;
    }

    try {
      const raised = reusable(payment);
      if (raised) return { payment: await this.reopen(payment, raised), attempt: raised };

      let order;
      try {
        order = await this.gateway.createOrder({
          amountPaise,
          currency: payment.currency,
          receipt: payment.rideCode,
          notes: {
            rideId: payment.rideId.toString(),
            rideCode: payment.rideCode,
            paymentId: payment._id.toString(),
          },
        });
      } catch (error) {
        throw this.gatewayFailure(error, "Could not start the payment. Please try again.");
      }
      if (order.amount !== amountPaise || order.currency !== payment.currency)
        throw new ApiException(
          HttpStatus.BAD_GATEWAY,
          "The payment gateway returned an unexpected order",
          "PAYMENT_GATEWAY_ERROR",
        );

      const attempt: PaymentAttempt = { orderId: order.id, amountPaise, status: PaymentAttemptStatus.CREATED };
      const updated = await this.paymentModel
        .findOneAndUpdate(
          { _id: payment._id },
          {
            $push: {
              attempts: attempt,
              events: {
                $each: [
                  {
                    type: "ORDER_CREATED",
                    source: PaymentEventSource.CUSTOMER,
                    at: new Date(),
                    razorpayOrderId: order.id,
                  },
                ],
                $slice: -MAX_EVENTS,
              },
            },
            $set: { razorpayOrderId: order.id, status: PaymentStatus.CREATED },
            $unset: { orderLockUntil: 1, failureCode: 1, failureReason: 1 },
          },
          { returnDocument: "after" },
        )
        .exec();
      if (!updated) throw apiNotFound("Payment not found", "PAYMENT_NOT_FOUND");
      this.logger.log(`Razorpay order ${order.id} for ride ${payment.rideCode} (${amountPaise}p)`);
      return { payment: updated, attempt: updated.attempts[updated.attempts.length - 1] };
    } finally {
      await this.paymentModel
        .updateOne({ _id: payment._id, orderLockUntil: { $exists: true } }, { $unset: { orderLockUntil: 1 } })
        .exec();
    }
  }

  /** A retry on an existing order: the payment is open again. */
  private async reopen(payment: PaymentDocument, attempt: PaymentAttempt): Promise<PaymentDocument> {
    if (payment.status !== PaymentStatus.FAILED && payment.razorpayOrderId === attempt.orderId) return payment;
    const updated = await this.paymentModel
      .findOneAndUpdate(
        { _id: payment._id, status: { $in: OPEN_PAYMENT_STATUSES } },
        {
          $set: { status: PaymentStatus.CREATED, razorpayOrderId: attempt.orderId },
          $unset: { failureCode: 1, failureReason: 1 },
        },
        { returnDocument: "after" },
      )
      .exec();
    return updated ?? payment;
  }

  private async settleCaptured(
    payment: PaymentDocument,
    gatewayPayment: RazorpayPayment,
    source: PaymentEventSource,
    signature?: string,
  ): Promise<PaymentDocument> {
    const now = new Date();
    const set: Record<string, unknown> = {
      status: PaymentStatus.CAPTURED,
      razorpayPaymentId: gatewayPayment.id,
      razorpayOrderId: gatewayPayment.order_id,
      // Method comes from Razorpay, never from the app.
      method: gatewayPayment.method,
      methodDetails: {
        bank: gatewayPayment.bank ?? undefined,
        wallet: gatewayPayment.wallet ?? undefined,
        cardNetwork: gatewayPayment.card?.network ?? undefined,
        cardType: gatewayPayment.card?.type ?? undefined,
        cardLast4: gatewayPayment.card?.last4 ?? undefined,
      },
      paidAt: now,
      "attempts.$[paid].status": PaymentAttemptStatus.PAID,
      "attempts.$[paid].razorpayPaymentId": gatewayPayment.id,
    };
    if (signature) set.razorpaySignature = signature;

    let updated: PaymentDocument | null;
    try {
      updated = await this.paymentModel
        .findOneAndUpdate(
          { _id: payment._id, status: { $in: OPEN_PAYMENT_STATUSES } },
          {
            $set: set,
            $unset: { failureCode: 1, failureReason: 1, processingSince: 1, processingPaymentId: 1, orderLockUntil: 1 },
            $push: {
              events: {
                $each: [
                  {
                    type: "PAYMENT_CAPTURED",
                    source,
                    at: now,
                    razorpayOrderId: gatewayPayment.order_id ?? undefined,
                    razorpayPaymentId: gatewayPayment.id,
                    detail: gatewayPayment.method,
                  },
                ],
                $slice: -MAX_EVENTS,
              },
            },
          },
          { returnDocument: "after", arrayFilters: [{ "paid.orderId": gatewayPayment.order_id }] },
        )
        .exec();
    } catch (error) {
      if (isDuplicateKey(error, "uniq_razorpay_payment_id"))
        throw new ApiException(HttpStatus.CONFLICT, "This payment was already used", "PAYMENT_ID_REUSED");
      throw error;
    }

    if (updated) {
      this.logger.log(
        `Payment ${updated._id.toString()} CAPTURED (${gatewayPayment.id}, ${gatewayPayment.method ?? "?"}) via ${source}`,
      );
      await this.afterCapture(updated);
      return updated;
    }

    // Someone else settled it first (verify vs webhook race).
    const current = await this.paymentModel.findById(payment._id).exec();
    if (!current) throw apiNotFound("Payment not found", "PAYMENT_NOT_FOUND");
    if (current.razorpayPaymentId === gatewayPayment.id) await this.afterCapture(current);
    else if (SETTLED_PAYMENT_STATUSES.includes(current.status))
      await this.recordDuplicate(current, gatewayPayment, source);
    return current;
  }

  private async settleFailed(
    payment: PaymentDocument,
    failure: {
      orderId?: string;
      razorpayPaymentId?: string;
      code: string;
      reason: string;
      source: PaymentEventSource;
      fromClient?: boolean;
    },
  ): Promise<PaymentDocument> {
    const event = {
      type: failure.fromClient ? "CLIENT_REPORTED_FAILURE" : "PAYMENT_FAILED",
      source: failure.source,
      at: new Date(),
      razorpayOrderId: failure.orderId,
      razorpayPaymentId: failure.razorpayPaymentId,
      detail: `${failure.code}: ${failure.reason}`,
    };
    // A failure of an older attempt must not flip a newer one Razorpay is processing.
    if (
      payment.processingPaymentId &&
      failure.razorpayPaymentId &&
      payment.processingPaymentId !== failure.razorpayPaymentId
    ) {
      await this.pushEvent(payment._id, event);
      return payment;
    }

    const set: Record<string, unknown> = {
      status: PaymentStatus.FAILED,
      failureCode: failure.code,
      failureReason: failure.reason,
    };
    const options: { returnDocument: "after"; arrayFilters?: Record<string, unknown>[] } = { returnDocument: "after" };
    if (failure.orderId) {
      set["attempts.$[failed].status"] = PaymentAttemptStatus.FAILED;
      set["attempts.$[failed].failureCode"] = failure.code;
      set["attempts.$[failed].failureReason"] = failure.reason;
      if (failure.razorpayPaymentId) set["attempts.$[failed].razorpayPaymentId"] = failure.razorpayPaymentId;
      options.arrayFilters = [{ "failed.orderId": failure.orderId, "failed.status": { $ne: PaymentAttemptStatus.PAID } }];
    }
    const update: UpdateQuery<Payment> = {
      $set: set,
      $unset: { processingSince: 1, processingPaymentId: 1 },
      $push: { events: { $each: [event], $slice: -MAX_EVENTS } },
    };
    const updated = await this.paymentModel
      .findOneAndUpdate({ _id: payment._id, status: { $in: OPEN_PAYMENT_STATUSES } }, update, options)
      .exec();
    if (!updated) return (await this.paymentModel.findById(payment._id).exec()) ?? payment;

    await this.rides.apply({
      rideId: updated.rideId,
      // A client report can only fail a ride Razorpay is not processing.
      from: failure.fromClient
        ? [RidePaymentStatus.PENDING, RidePaymentStatus.ORDER_CREATED]
        : [RidePaymentStatus.PENDING, RidePaymentStatus.ORDER_CREATED, RidePaymentStatus.PROCESSING],
      to: RidePaymentStatus.FAILED,
      payment: { paymentId: updated._id, failureReason: failure.reason },
    });
    this.logger.log(`Payment ${updated._id.toString()} FAILED via ${failure.source}: ${failure.code}`);
    return updated;
  }

  private async markProcessing(
    payment: PaymentDocument,
    orderId: string,
    razorpayPaymentId: string,
    source: PaymentEventSource,
    detail: string,
    authorized = false,
  ): Promise<PaymentDocument> {
    const updated = await this.paymentModel
      .findOneAndUpdate(
        { _id: payment._id, status: { $in: OPEN_PAYMENT_STATUSES } },
        {
          $set: {
            status: authorized ? PaymentStatus.AUTHORIZED : PaymentStatus.CREATED,
            processingPaymentId: razorpayPaymentId,
            "attempts.$[seen].status": PaymentAttemptStatus.ATTEMPTED,
            "attempts.$[seen].razorpayPaymentId": razorpayPaymentId,
          },
          $min: { processingSince: new Date() },
          $push: {
            events: {
              $each: [{ type: "PAYMENT_PROCESSING", source, at: new Date(), razorpayOrderId: orderId, razorpayPaymentId, detail }],
              $slice: -MAX_EVENTS,
            },
          },
        },
        {
          returnDocument: "after",
          arrayFilters: [{ "seen.orderId": orderId, "seen.status": { $ne: PaymentAttemptStatus.PAID } }],
        },
      )
      .exec();
    if (!updated) return (await this.paymentModel.findById(payment._id).exec()) ?? payment;
    await this.rides.apply({
      rideId: updated.rideId,
      from: [RidePaymentStatus.PENDING, RidePaymentStatus.ORDER_CREATED, RidePaymentStatus.FAILED],
      to: RidePaymentStatus.PROCESSING,
      payment: { paymentId: updated._id },
      clear: ["failureReason"],
    });
    return updated;
  }

  private async recordDuplicate(
    payment: PaymentDocument,
    gatewayPayment: RazorpayPayment,
    source: PaymentEventSource,
  ): Promise<void> {
    const result = await this.paymentModel
      .updateOne(
        { _id: payment._id, "duplicateCaptures.razorpayPaymentId": { $ne: gatewayPayment.id } },
        {
          $push: {
            duplicateCaptures: {
              razorpayPaymentId: gatewayPayment.id,
              razorpayOrderId: gatewayPayment.order_id ?? undefined,
              amountPaise: gatewayPayment.amount,
              detectedAt: new Date(),
            },
            events: {
              $each: [
                {
                  type: "DUPLICATE_CAPTURE",
                  source,
                  at: new Date(),
                  razorpayOrderId: gatewayPayment.order_id ?? undefined,
                  razorpayPaymentId: gatewayPayment.id,
                  detail: "Ride already paid — refund this payment from the Razorpay dashboard",
                },
              ],
              $slice: -MAX_EVENTS,
            },
          },
        },
      )
      .exec();
    if (result.modifiedCount)
      this.logger.error(
        `DUPLICATE CAPTURE ${gatewayPayment.id} on already-paid ride ${payment.rideCode} (payment ${payment._id.toString()}) — refund required`,
      );
  }

  async pushEvent(paymentId: Types.ObjectId, event: Omit<PaymentEvent, "at"> & { at?: Date }): Promise<void> {
    await this.paymentModel
      .updateOne(
        { _id: paymentId },
        { $push: { events: { $each: [{ ...event, at: event.at ?? new Date() }], $slice: -MAX_EVENTS } } },
      )
      .exec();
  }

  private async findForCustomer(customerUserId: string, paymentId: string): Promise<PaymentDocument> {
    const payment = await this.paymentModel
      .findOne({ _id: new Types.ObjectId(paymentId), customerId: new Types.ObjectId(customerUserId) })
      .exec();
    if (!payment) throw apiNotFound("Payment not found", "PAYMENT_NOT_FOUND");
    return payment;
  }

  private async toCheckout(
    payment: PaymentDocument,
    attempt: PaymentAttempt,
    customerUserId: string,
  ): Promise<CheckoutView> {
    const customer = await this.userModel.findById(customerUserId).select("firstName lastName phone email").lean().exec();
    const ride = await this.rides.findById(payment.rideId);
    return {
      payment: this.view(payment, ride ?? undefined),
      checkout: {
        key: this.gateway.keyId,
        orderId: attempt.orderId,
        amount: attempt.amountPaise,
        currency: payment.currency,
        name: this.brandName,
        description: `Ride ${payment.rideCode}`,
        prefill: {
          name: nameOf(customer) || undefined,
          contact: customer?.phone,
          email: customer?.email,
        },
        notes: { rideId: payment.rideId.toString(), paymentId: payment._id.toString(), rideCode: payment.rideCode },
      },
    };
  }

  view(payment: PaymentDocument, ride?: RideDocument): PaymentView {
    const ridePaymentStatus = ride
      ? effectivePaymentStatus(ride)
      : payment.status === PaymentStatus.CAPTURED
        ? RidePaymentStatus.SUCCESS
        : payment.status === PaymentStatus.FAILED
          ? RidePaymentStatus.FAILED
          : payment.processingPaymentId
            ? RidePaymentStatus.PROCESSING
            : RidePaymentStatus.ORDER_CREATED;
    return {
      id: payment._id.toString(),
      rideId: payment.rideId.toString(),
      rideCode: payment.rideCode,
      gateway: payment.gateway,
      amount: toRupees(payment.amountPaise),
      currency: payment.currency,
      status: payment.status,
      ridePaymentStatus,
      method: payment.method,
      methodDetails: payment.methodDetails
        ? {
            method: payment.method,
            bank: payment.methodDetails.bank,
            wallet: payment.methodDetails.wallet,
            cardNetwork: payment.methodDetails.cardNetwork,
            cardType: payment.methodDetails.cardType,
            cardLast4: payment.methodDetails.cardLast4,
          }
        : undefined,
      razorpayOrderId: payment.razorpayOrderId,
      razorpayPaymentId: payment.razorpayPaymentId,
      failureReason: payment.failureReason,
      paidAt: payment.paidAt,
      refund:
        payment.refundAmountPaise !== undefined
          ? {
              refundId: payment.refundId,
              amount: toRupees(payment.refundAmountPaise),
              status: payment.refundStatus,
              refundedAt: payment.refundedAt,
            }
          : undefined,
      createdAt: payment.get("createdAt") as Date,
      updatedAt: payment.get("updatedAt") as Date,
    };
  }

  private assertGateway(): void {
    if (!this.gateway.isConfigured)
      throw new ApiException(
        HttpStatus.SERVICE_UNAVAILABLE,
        "Online payments are not available right now",
        "PAYMENT_GATEWAY_NOT_CONFIGURED",
      );
  }

  private alreadyPaid(payment: PaymentDocument): ApiException {
    return new ApiException(HttpStatus.CONFLICT, "This ride is already paid", "PAYMENT_ALREADY_COMPLETED", {
      paymentId: payment._id.toString(),
    });
  }

  private gatewayFailure(error: unknown, message: string): ApiException {
    if (error instanceof ApiException) return error;
    this.logger.warn(`Razorpay call failed: ${error instanceof Error ? error.message : String(error)}`);
    const clientError = error instanceof RazorpayGatewayError && error.status !== undefined && error.status < 500;
    return new ApiException(
      clientError ? HttpStatus.BAD_REQUEST : HttpStatus.BAD_GATEWAY,
      message,
      "PAYMENT_GATEWAY_ERROR",
    );
  }
}
