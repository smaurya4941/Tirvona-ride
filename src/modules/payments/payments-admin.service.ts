import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectModel } from "@nestjs/mongoose";
import type { Model, QueryFilter } from "mongoose";
import { Types } from "mongoose";
import { apiBadRequest, apiNotFound } from "../../common/exceptions/api.exception";
import { toRupees } from "../../common/utils/money";
import { startOfDayInTimeZone } from "../../common/utils/time";
import { DriverProfile } from "../drivers/schemas/driver-profile.schema";
import { EarningsAdminService } from "../earnings/earnings-admin.service";
import { EarningsService } from "../earnings/earnings.service";
import { RidePaymentStateService } from "../rides/ride-payment-state.service";
import type { RideDocument } from "../rides/schemas/ride.schema";
import { User } from "../users/schemas/user.schema";
import type { AdminPaymentsQueryDto } from "./dto/payment.dto";
import { PaymentStatus } from "./interfaces/payment-status";
import type {
  AdminPaymentDetail,
  AdminPaymentListItem,
  AdminPaymentPerson,
  AdminPaymentsSummary,
} from "./interfaces/payment-views";
import { PaymentsService } from "./payments.service";
import { Payment } from "./schemas/payment.schema";
import type { PaymentDocument } from "./schemas/payment.schema";

const DAY_MS = 86_400_000;
const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const nameOf = (user?: { firstName?: string; lastName?: string } | null): string =>
  [user?.firstName, user?.lastName].filter(Boolean).join(" ");
const isDateOnly = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value);

type DriverPerson = AdminPaymentPerson & { driverId: string; driverCode: string };

/** Admin read side of payments: list with filters, detail, headline numbers. */
@Injectable()
export class PaymentsAdminService {
  private readonly timeZone: string;

  constructor(
    @InjectModel(Payment.name) private readonly paymentModel: Model<Payment>,
    @InjectModel(User.name) private readonly userModel: Model<User>,
    @InjectModel(DriverProfile.name) private readonly driverModel: Model<DriverProfile>,
    private readonly payments: PaymentsService,
    private readonly rides: RidePaymentStateService,
    private readonly earnings: EarningsService,
    private readonly earningsAdmin: EarningsAdminService,
    config: ConfigService,
  ) {
    this.timeZone = config.getOrThrow<string>("appTimeZone");
  }

  async list(
    query: AdminPaymentsQueryDto,
  ): Promise<{ items: AdminPaymentListItem[]; page: number; limit: number; total: number; hasMore: boolean }> {
    const filter = await this.buildFilter(query);
    const [payments, total] = await Promise.all([
      this.paymentModel
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .exec(),
      this.paymentModel.countDocuments(filter).exec(),
    ]);
    const [people, rides] = await Promise.all([
      this.people(payments),
      this.rides.findManyByIds(payments.map((payment) => payment.rideId)),
    ]);
    const rideById = new Map(rides.map((ride) => [ride._id.toString(), ride]));
    return {
      items: payments.map((payment) => this.toListItem(payment, people, rideById.get(payment.rideId.toString()))),
      page: query.page,
      limit: query.limit,
      total,
      hasMore: query.page * query.limit < total,
    };
  }

  async detail(paymentId: string): Promise<AdminPaymentDetail> {
    const payment = await this.paymentModel.findById(paymentId).exec();
    if (!payment) throw apiNotFound("Payment not found", "PAYMENT_NOT_FOUND");
    const [people, ride, earning] = await Promise.all([
      this.people([payment]),
      this.rides.findById(payment.rideId),
      this.earnings.findForPayment(payment._id),
    ]);
    return {
      ...this.toListItem(payment, people, ride ?? undefined),
      ride: ride
        ? {
            id: ride._id.toString(),
            rideCode: ride.rideCode,
            status: ride.status,
            rideType: ride.rideType,
            pickupAddress: ride.pickup.address,
            destinationAddress: ride.destination.address,
            completedAt: ride.completedAt,
            finalFare: ride.fare.finalFare,
            estimatedFare: ride.fare.estimatedFare,
          }
        : null,
      attemptLog: payment.attempts.map((attempt) => ({
        orderId: attempt.orderId,
        amount: toRupees(attempt.amountPaise),
        status: attempt.status,
        razorpayPaymentId: attempt.razorpayPaymentId,
        failureCode: attempt.failureCode,
        failureReason: attempt.failureReason,
        createdAt: attempt.createdAt,
        updatedAt: attempt.updatedAt,
      })),
      events: [...payment.events].reverse().map((event) => ({
        type: event.type,
        source: event.source,
        at: event.at,
        razorpayOrderId: event.razorpayOrderId,
        razorpayPaymentId: event.razorpayPaymentId,
        detail: event.detail,
      })),
      duplicateCaptures: payment.duplicateCaptures.map((duplicate) => ({
        razorpayPaymentId: duplicate.razorpayPaymentId,
        razorpayOrderId: duplicate.razorpayOrderId,
        amount: toRupees(duplicate.amountPaise),
        detectedAt: duplicate.detectedAt,
      })),
      earning: earning
        ? {
            id: earning.id,
            grossFare: earning.grossFare,
            commissionRate: earning.commissionRate,
            commissionAmount: earning.commissionAmount,
            netEarning: earning.netEarning,
            status: earning.status,
          }
        : null,
    };
  }

  async summary(): Promise<AdminPaymentsSummary> {
    const today = startOfDayInTimeZone(new Date(), this.timeZone);
    const captured = { status: { $in: [PaymentStatus.CAPTURED, PaymentStatus.REFUNDED, PaymentStatus.PARTIALLY_REFUNDED] } };
    const [todayRows, allRows, failedToday, outstanding, needsAttention, earnings] = await Promise.all([
      this.paymentModel
        .aggregate<{ amount: number; count: number }>([
          { $match: { ...captured, paidAt: { $gte: today } } },
          { $group: { _id: null, amount: { $sum: "$amountPaise" }, count: { $sum: 1 } } },
        ])
        .exec(),
      this.paymentModel
        .aggregate<{ amount: number; count: number }>([
          { $match: captured },
          { $group: { _id: null, amount: { $sum: "$amountPaise" }, count: { $sum: 1 } } },
        ])
        .exec(),
      this.paymentModel.countDocuments({ status: PaymentStatus.FAILED, updatedAt: { $gte: today } }).exec(),
      this.rides.outstanding(),
      this.paymentModel.countDocuments({ "duplicateCaptures.0": { $exists: true } }).exec(),
      this.earningsAdmin.totals(),
    ]);
    return {
      currency: "INR",
      collectedToday: toRupees(todayRows[0]?.amount ?? 0),
      capturedToday: todayRows[0]?.count ?? 0,
      collectedTotal: toRupees(allRows[0]?.amount ?? 0),
      capturedTotal: allRows[0]?.count ?? 0,
      commissionTotal: earnings.commission,
      failedToday,
      outstandingRides: outstanding.rides,
      outstandingAmount: outstanding.amount,
      needsAttention,
    };
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  private async buildFilter(query: AdminPaymentsQueryDto): Promise<QueryFilter<Payment>> {
    const filter: QueryFilter<Payment> = {};
    const and: QueryFilter<Payment>[] = [];
    if (query.status) filter.status = query.status;

    const createdAt: Record<string, Date> = {};
    if (query.from) createdAt.$gte = this.boundary(query.from, false);
    if (query.to) createdAt.$lt = this.boundary(query.to, true);
    if (createdAt.$gte && createdAt.$lt && createdAt.$gte >= createdAt.$lt)
      throw apiBadRequest("'from' must be before 'to'", "VALIDATION_FAILED");
    if (Object.keys(createdAt).length) filter.createdAt = createdAt;

    if (query.ride) and.push({ rideId: { $in: await this.rides.findIdsByReference(query.ride) } });

    if (query.customer) {
      const pattern = escapeRegex(query.customer.trim());
      const customers = await this.userModel
        .find({
          $or: [
            { phone: { $regex: pattern } },
            { firstName: { $regex: pattern, $options: "i" } },
            { lastName: { $regex: pattern, $options: "i" } },
          ],
        })
        .select("_id")
        .limit(200)
        .lean()
        .exec();
      and.push({ customerId: { $in: customers.map((customer) => customer._id) } });
    }

    if (query.driver) {
      const pattern = escapeRegex(query.driver.trim());
      const users = await this.userModel
        .find({
          $or: [
            { phone: { $regex: pattern } },
            { firstName: { $regex: pattern, $options: "i" } },
            { lastName: { $regex: pattern, $options: "i" } },
          ],
        })
        .select("_id")
        .limit(200)
        .lean()
        .exec();
      const drivers = await this.driverModel
        .find({
          $or: [
            { driverCode: { $regex: `^${pattern}`, $options: "i" } },
            { userId: { $in: users.map((user) => user._id) } },
          ],
        })
        .select("_id")
        .limit(200)
        .lean()
        .exec();
      and.push({ driverId: { $in: drivers.map((driver) => driver._id) } });
    }

    if (query.payment) {
      const term = query.payment.trim();
      if (/^[0-9a-f]{24}$/i.test(term)) and.push({ _id: new Types.ObjectId(term) });
      else if (term.startsWith("pay_"))
        and.push({ $or: [{ razorpayPaymentId: term }, { "attempts.razorpayPaymentId": term }] });
      else if (term.startsWith("order_")) and.push({ "attempts.orderId": term });
      else throw apiBadRequest("Search a payment by its id, pay_… or order_…", "VALIDATION_FAILED");
    }

    if (and.length) filter.$and = and;
    return filter;
  }

  /** A date-only bound covers the whole local business day. */
  private boundary(value: string, end: boolean): Date {
    if (isDateOnly(value)) {
      const start = startOfDayInTimeZone(new Date(`${value}T12:00:00Z`), this.timeZone);
      return end ? new Date(start.getTime() + DAY_MS) : start;
    }
    const instant = new Date(value);
    if (Number.isNaN(instant.getTime())) throw apiBadRequest("Invalid date filter", "VALIDATION_FAILED");
    return instant;
  }

  private async people(
    payments: PaymentDocument[],
  ): Promise<{ customers: Map<string, AdminPaymentPerson>; drivers: Map<string, DriverPerson> }> {
    const profiles = await this.driverModel
      .find({ _id: { $in: payments.map((payment) => payment.driverId) } })
      .select("driverCode userId")
      .lean()
      .exec();
    const users = await this.userModel
      .find({
        _id: {
          $in: [...payments.map((payment) => payment.customerId), ...profiles.map((profile) => profile.userId)],
        },
      })
      .select("firstName lastName phone")
      .lean()
      .exec();
    const userById = new Map(users.map((user) => [user._id.toString(), user]));
    const customers = new Map<string, AdminPaymentPerson>();
    for (const payment of payments) {
      const user = userById.get(payment.customerId.toString());
      if (user) customers.set(payment.customerId.toString(), { id: user._id.toString(), name: nameOf(user), phone: user.phone });
    }
    const drivers = new Map<string, DriverPerson>();
    for (const profile of profiles) {
      const user = userById.get(profile.userId.toString());
      drivers.set(profile._id.toString(), {
        id: profile.userId.toString(),
        driverId: profile._id.toString(),
        driverCode: profile.driverCode,
        name: nameOf(user) || "Driver",
        phone: user?.phone ?? "",
      });
    }
    return { customers, drivers };
  }

  private toListItem(
    payment: PaymentDocument,
    people: { customers: Map<string, AdminPaymentPerson>; drivers: Map<string, DriverPerson> },
    ride?: RideDocument,
  ): AdminPaymentListItem {
    return {
      ...this.payments.view(payment, ride),
      customer: people.customers.get(payment.customerId.toString()) ?? null,
      driver: people.drivers.get(payment.driverId.toString()) ?? null,
      attempts: payment.attempts.length,
      needsAttention: payment.duplicateCaptures.length > 0,
    };
  }
}
