import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import type { Model, PipelineStage, QueryFilter } from "mongoose";
import { Types } from "mongoose";
import { apiBadRequest, apiNotFound } from "../../common/exceptions/api.exception";
import { DriverProfile } from "../drivers/schemas/driver-profile.schema";
import { DriverLocationService } from "../locations/driver-location.service";
import { RidesAdminService } from "../rides/rides-admin.service";
import type { AdminRideDetail } from "../rides/rides-admin.service";
import { ACTIVE_RIDE_STATUSES, RideStatus } from "../rides/ride-state-machine";
import { RideViewService } from "../rides/ride-view.service";
import type { RideView } from "../rides/ride-view.service";
import type { Page } from "../rides/rides.service";
import { Ride } from "../rides/schemas/ride.schema";
import type { RideDocument } from "../rides/schemas/ride.schema";
import { User } from "../users/schemas/user.schema";
import { CircuitLedgerService } from "./circuit-ledger.service";
import type { CircuitLedgerView } from "./circuit-ledger.service";
import { RideKind } from "./circuit-ride.types";
import type { AdminListCircuitRidesQueryDto, CircuitReportQueryDto } from "./dto/circuit-ride.dto";

interface PersonRef {
  id: string;
  name: string;
  phone: string;
}

export interface AdminCircuitRideItem extends RideView {
  customer: PersonRef | null;
  driver: (PersonRef & { driverId: string; driverCode: string }) | null;
  /** Where the driver is now (live circuits only). */
  driverLocation?: { latitude: number; longitude: number; updatedAt: Date; fresh: boolean };
}

export interface AdminCircuitRideDetail extends AdminRideDetail {
  /** Stop-by-stop audit trail: who did what, when, from which state to which. */
  timeline: CircuitLedgerView[];
}

export interface CircuitReport {
  range: { startDate?: string; endDate?: string };
  bookings: { total: number; completed: number; cancelled: number; noDriver: number; active: number; paymentPending: number };
  revenue: {
    gross: number;
    packageRevenue: number;
    extraDistanceRevenue: number;
    extraTimeRevenue: number;
    discounts: number;
    refunds: number;
  };
  operations: { averageDurationSeconds: number; averageDistanceMeters: number; averageStopsCompleted: number; completedStopsTotal: number };
  packages: Array<{
    packageId: string;
    code: string;
    name: string;
    city: string;
    bookings: number;
    completed: number;
    cancelled: number;
    revenue: number;
    averageDurationSeconds: number;
    averageDistanceMeters: number;
  }>;
}

const nameOf = (user?: { firstName?: string; lastName?: string } | null): string => [user?.firstName, user?.lastName].filter(Boolean).join(" ");
const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** Admin's read side for circuits: bookings, the live board, one booking in full, and reports. */
@Injectable()
export class AdminCircuitRidesService {
  constructor(
    @InjectModel(Ride.name) private readonly rideModel: Model<Ride>,
    @InjectModel(User.name) private readonly userModel: Model<User>,
    @InjectModel(DriverProfile.name) private readonly driverModel: Model<DriverProfile>,
    private readonly views: RideViewService,
    private readonly ridesAdmin: RidesAdminService,
    private readonly ledger: CircuitLedgerService,
    private readonly driverLocations: DriverLocationService,
  ) {}

  async list(query: AdminListCircuitRidesQueryDto): Promise<Page<AdminCircuitRideItem>> {
    const filter: QueryFilter<Ride> = { kind: RideKind.CIRCUIT };
    if (query.status) filter.status = query.status;
    if (query.packageId) filter["circuit.packageId"] = new Types.ObjectId(query.packageId);
    if (query.city) filter["circuit.city"] = { $regex: `^${escapeRegex(query.city)}$`, $options: "i" };
    if (query.driverId) filter.driverId = new Types.ObjectId(query.driverId);
    if (query.paymentStatus) filter.paymentStatus = query.paymentStatus as never;
    const start = query.startDate ? new Date(query.startDate) : undefined;
    const end = query.endDate ? new Date(query.endDate) : undefined;
    if (start && end && start.getTime() >= end.getTime()) throw apiBadRequest("startDate must be before endDate", "RIDE_HISTORY_RANGE_INVALID");
    if (start || end) filter.requestedAt = { ...(start && { $gte: start }), ...(end && { $lt: end }) };
    if (query.q) {
      const term = query.q.trim();
      const customers = await this.userModel.find({ phone: { $regex: escapeRegex(term) } }).select("_id").limit(50).lean().exec();
      filter.$or = [{ rideCode: { $regex: `^${escapeRegex(term.toUpperCase())}` } }, { customerId: { $in: customers.map((customer) => customer._id) } }];
    }

    const [rides, total] = await Promise.all([
      this.rideModel
        .find(filter)
        .sort({ requestedAt: -1, _id: -1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .exec(),
      this.rideModel.countDocuments(filter).exec(),
    ]);
    return {
      items: await this.decorate(rides),
      page: query.page,
      limit: query.limit,
      total,
      hasMore: query.page * query.limit < total,
    };
  }

  /** Every circuit that is not finished: searching, on the way, running — with the driver's position. */
  async live(): Promise<AdminCircuitRideItem[]> {
    const rides = await this.rideModel
      .find({ kind: RideKind.CIRCUIT, status: { $in: [...ACTIVE_RIDE_STATUSES] } })
      .sort({ requestedAt: -1 })
      .limit(200)
      .exec();
    const items = await this.decorate(rides);
    const drivers = await this.driverModel
      .find({ _id: { $in: rides.flatMap((ride) => (ride.driverId ? [ride.driverId] : [])) } })
      .select("currentLocation locationUpdatedAt")
      .lean()
      .exec();
    const byId = new Map(drivers.map((driver) => [driver._id.toString(), driver]));
    return items.map((item, index) => {
      const driverId = rides[index].driverId?.toString();
      const driver = driverId ? byId.get(driverId) : undefined;
      const position = driver && driverId ? this.driverLocations.positionFor(driverId, driver) : undefined;
      return position
        ? { ...item, driverLocation: { latitude: position.latitude, longitude: position.longitude, updatedAt: position.updatedAt, fresh: position.fresh } }
        : item;
    });
  }

  async detail(rideId: string): Promise<AdminCircuitRideDetail> {
    const ride = Types.ObjectId.isValid(rideId) ? await this.rideModel.findOne({ _id: rideId, kind: RideKind.CIRCUIT }).select("_id").lean().exec() : null;
    if (!ride) throw apiNotFound("Circuit booking not found", "CIRCUIT_NOT_FOUND");
    const [detail, timeline] = await Promise.all([this.ridesAdmin.detail(rideId), this.ledger.timeline(ride._id)]);
    return { ...detail, timeline };
  }

  /** Whether matching may offer this driver circuit rides. Takes effect from the next offer. */
  async setDriverEligibility(driverId: string, eligible: boolean): Promise<{ driverId: string; driverCode: string; circuitEligible: boolean }> {
    const driver = Types.ObjectId.isValid(driverId)
      ? await this.driverModel.findByIdAndUpdate(driverId, { $set: { circuitEligible: eligible } }, { returnDocument: "after" }).select("driverCode circuitEligible").lean().exec()
      : null;
    if (!driver) throw apiNotFound("Driver not found", "DRIVER_NOT_FOUND");
    return { driverId: driver._id.toString(), driverCode: driver.driverCode, circuitEligible: driver.circuitEligible !== false };
  }

  /** Bookings, revenue, operations and per-package performance for rides booked in the range. */
  async report(query: CircuitReportQueryDto): Promise<CircuitReport> {
    const start = query.startDate ? new Date(query.startDate) : undefined;
    const end = query.endDate ? new Date(query.endDate) : undefined;
    if (start && end && start.getTime() >= end.getTime()) throw apiBadRequest("startDate must be before endDate", "RIDE_HISTORY_RANGE_INVALID");
    const match: QueryFilter<Ride> = { kind: RideKind.CIRCUIT };
    if (start || end) match.requestedAt = { ...(start && { $gte: start }), ...(end && { $lt: end }) };

    const completed = { $eq: ["$status", RideStatus.COMPLETED] };
    const ifCompleted = (value: unknown) => ({ $cond: [completed, value, 0] });
    const stopsDone = {
      $size: {
        $filter: { input: { $ifNull: ["$circuit.stops", []] }, as: "stop", cond: { $eq: ["$$stop.status", "COMPLETED"] } },
      },
    };

    const [overall] = await this.rideModel
      .aggregate<Record<string, number>>([
        { $match: match },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            completed: { $sum: { $cond: [completed, 1, 0] } },
            cancelled: { $sum: { $cond: [{ $eq: ["$status", RideStatus.CANCELLED] }, 1, 0] } },
            noDriver: { $sum: { $cond: [{ $eq: ["$status", RideStatus.NO_DRIVER_AVAILABLE] }, 1, 0] } },
            active: { $sum: { $cond: ["$isActive", 1, 0] } },
            paymentPending: {
              $sum: { $cond: [{ $and: [completed, { $in: ["$paymentStatus", ["PENDING", "FAILED"]] }] }, 1, 0] },
            },
            gross: { $sum: ifCompleted({ $ifNull: ["$fare.final.total", 0] }) },
            packageRevenue: { $sum: ifCompleted({ $ifNull: ["$fare.final.baseFare", 0] }) },
            extraDistanceRevenue: { $sum: ifCompleted({ $ifNull: ["$fare.final.distanceCharge", 0] }) },
            extraTimeRevenue: { $sum: ifCompleted({ $ifNull: ["$fare.final.timeCharge", 0] }) },
            discounts: { $sum: ifCompleted({ $ifNull: ["$fare.final.discount", 0] }) },
            refunds: { $sum: { $ifNull: ["$payment.refundedAmount", 0] } },
            durationSum: { $sum: ifCompleted({ $ifNull: ["$fare.final.durationSeconds", 0] }) },
            distanceSum: { $sum: ifCompleted({ $ifNull: ["$fare.final.distanceMeters", 0] }) },
            stopsDoneSum: { $sum: ifCompleted(stopsDone) },
          },
        },
      ])
      .exec();

    const perPackage = await this.rideModel
      .aggregate<Record<string, unknown>>([
        { $match: match },
        {
          $group: {
            _id: "$circuit.packageId",
            code: { $first: "$circuit.packageCode" },
            name: { $first: "$circuit.name" },
            city: { $first: "$circuit.city" },
            bookings: { $sum: 1 },
            completed: { $sum: { $cond: [completed, 1, 0] } },
            cancelled: { $sum: { $cond: [{ $eq: ["$status", RideStatus.CANCELLED] }, 1, 0] } },
            revenue: { $sum: ifCompleted({ $ifNull: ["$fare.final.total", 0] }) },
            durationSum: { $sum: ifCompleted({ $ifNull: ["$fare.final.durationSeconds", 0] }) },
            distanceSum: { $sum: ifCompleted({ $ifNull: ["$fare.final.distanceMeters", 0] }) },
          },
        },
        { $sort: { bookings: -1 } },
      ] as PipelineStage[])
      .exec();

    const o = overall ?? {};
    const done = num(o.completed);
    return {
      range: { startDate: query.startDate, endDate: query.endDate },
      bookings: {
        total: num(o.total),
        completed: done,
        cancelled: num(o.cancelled),
        noDriver: num(o.noDriver),
        active: num(o.active),
        paymentPending: num(o.paymentPending),
      },
      revenue: {
        gross: num(o.gross),
        packageRevenue: num(o.packageRevenue),
        extraDistanceRevenue: num(o.extraDistanceRevenue),
        extraTimeRevenue: num(o.extraTimeRevenue),
        discounts: num(o.discounts),
        refunds: num(o.refunds),
      },
      operations: {
        averageDurationSeconds: done ? Math.round(num(o.durationSum) / done) : 0,
        averageDistanceMeters: done ? Math.round(num(o.distanceSum) / done) : 0,
        averageStopsCompleted: done ? Math.round((num(o.stopsDoneSum) / done) * 10) / 10 : 0,
        completedStopsTotal: num(o.stopsDoneSum),
      },
      packages: perPackage.map((row) => {
        const completedCount = num(row.completed);
        return {
          packageId: String(row._id),
          code: String(row.code ?? ""),
          name: String(row.name ?? ""),
          city: String(row.city ?? ""),
          bookings: num(row.bookings),
          completed: completedCount,
          cancelled: num(row.cancelled),
          revenue: num(row.revenue),
          averageDurationSeconds: completedCount ? Math.round(num(row.durationSum) / completedCount) : 0,
          averageDistanceMeters: completedCount ? Math.round(num(row.distanceSum) / completedCount) : 0,
        };
      }),
    };
  }

  /** Two batched lookups instead of 2 × N. */
  private async decorate(rides: RideDocument[]): Promise<AdminCircuitRideItem[]> {
    const users = await this.userModel
      .find({ _id: { $in: [...rides.map((ride) => ride.customerId), ...rides.flatMap((ride) => (ride.driverUserId ? [ride.driverUserId] : []))] } })
      .select("firstName lastName phone")
      .lean()
      .exec();
    const drivers = await this.driverModel
      .find({ _id: { $in: rides.flatMap((ride) => (ride.driverId ? [ride.driverId] : [])) } })
      .select("driverCode userId")
      .lean()
      .exec();
    const userById = new Map(users.map((user) => [user._id.toString(), user]));
    const driverById = new Map(drivers.map((driver) => [driver._id.toString(), driver]));
    return rides.map((ride) => {
      const customer = userById.get(ride.customerId.toString());
      const profile = ride.driverId ? driverById.get(ride.driverId.toString()) : undefined;
      const driverUser = profile ? userById.get(profile.userId.toString()) : undefined;
      return {
        ...this.views.base(ride),
        customer: customer ? { id: customer._id.toString(), name: nameOf(customer), phone: customer.phone } : null,
        driver:
          profile && driverUser
            ? { id: driverUser._id.toString(), driverId: profile._id.toString(), driverCode: profile.driverCode, name: nameOf(driverUser), phone: driverUser.phone }
            : null,
      };
    });
  }
}
