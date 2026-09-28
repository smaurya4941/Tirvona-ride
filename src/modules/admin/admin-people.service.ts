import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import type { Model, QueryFilter } from "mongoose";
import { Types } from "mongoose";
import { apiBadRequest, apiConflict, apiNotFound } from "../../common/exceptions/api.exception";
import { UserRole } from "../../common/types/user-role.enum";
import { toRupees } from "../../common/utils/money";
import { CancellationsService } from "../cancellations/cancellations.service";
import { SupportTicket } from "../complaints/schemas/support-ticket.schema";
import { DriversService } from "../drivers/drivers.service";
import { DriverProfile } from "../drivers/schemas/driver-profile.schema";
import { PaymentStatus } from "../payments/interfaces/payment-status";
import { Payment } from "../payments/schemas/payment.schema";
import { RideStatus } from "../rides/ride-state-machine";
import { RideViewService } from "../rides/ride-view.service";
import type { RideView } from "../rides/ride-view.service";
import type { Page } from "../rides/rides.service";
import { Ride } from "../rides/schemas/ride.schema";
import { User, UserStatus } from "../users/schemas/user.schema";
import type { UserDocument } from "../users/schemas/user.schema";
import { UsersService } from "../users/users.service";
import type { UserSummary } from "../users/users.service";
import { Vehicle } from "../vehicles/schemas/vehicle.schema";
import type { VehicleType } from "../vehicles/schemas/vehicle.schema";
import type { DriverListItem } from "./admin.service";
import type { AdminCustomersQueryDto, AdminDriversQueryDto, AdminVehiclesQueryDto } from "./dto/admin-people.dto";

export interface CustomerListItem {
  id: string;
  name: string;
  phone: string;
  email?: string;
  status: UserStatus;
  isPhoneVerified: boolean;
  totalRides: number;
  lastLoginAt?: Date;
  createdAt: Date;
}

export interface CustomerDetail {
  customer: UserSummary & { statusReason?: string; statusChangedAt?: Date };
  stats: {
    totalRides: number;
    completedRides: number;
    cancelledRides: number;
    totalPaid: number;
    outstandingCancellationFees: number;
    outstandingCancellationCount: number;
    complaints: number;
  };
  activeRide: RideView | null;
  recentRides: RideView[];
}

export interface VehicleListItem {
  id: string;
  vehicleType: VehicleType;
  registrationNumber: string;
  make?: string;
  model?: string;
  color?: string;
  manufactureYear?: number;
  isActive: boolean;
  createdAt: Date;
  driver: { id: string; driverCode: string; driverStatus: string; name: string; phone: string } | null;
}

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const nameOf = (user?: { firstName?: string; lastName?: string } | null): string =>
  [user?.firstName, user?.lastName].filter(Boolean).join(" ");

/** Admin reads over customers, drivers and vehicles (lists, search, detail). */
@Injectable()
export class AdminPeopleService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<User>,
    @InjectModel(Ride.name) private readonly rideModel: Model<Ride>,
    @InjectModel(Payment.name) private readonly paymentModel: Model<Payment>,
    @InjectModel(Vehicle.name) private readonly vehicleModel: Model<Vehicle>,
    @InjectModel(DriverProfile.name) private readonly driverModel: Model<DriverProfile>,
    @InjectModel(SupportTicket.name) private readonly ticketModel: Model<SupportTicket>,
    private readonly users: UsersService,
    private readonly drivers: DriversService,
    private readonly views: RideViewService,
    private readonly cancellations: CancellationsService,
  ) {}

  // ── Drivers ───────────────────────────────────────────────────────────

  async driverPage(query: AdminDriversQueryDto): Promise<Page<DriverListItem>> {
    const userIds = query.search ? await this.matchUsers(UserRole.DRIVER, query.search) : undefined;
    const { drivers, total } = await this.drivers.pageForAdmin({ ...query, userIds });
    const users = await this.userModel
      .find({ _id: { $in: drivers.map((driver) => driver.userId) } })
      .select("firstName lastName phone email")
      .lean()
      .exec();
    const byId = new Map(users.map((user) => [user._id.toString(), user]));
    return {
      items: drivers.map((driver) => {
        const user = byId.get(driver.userId.toString());
        return {
          driver: this.drivers.toSummary(driver),
          user: {
            id: driver.userId.toString(),
            firstName: user?.firstName ?? "",
            lastName: user?.lastName,
            phone: user?.phone ?? "",
            email: user?.email,
          },
        };
      }),
      page: query.page,
      limit: query.limit,
      total,
      hasMore: query.page * query.limit < total,
    };
  }

  // ── Customers ─────────────────────────────────────────────────────────

  async customerPage(query: AdminCustomersQueryDto): Promise<Page<CustomerListItem>> {
    const filter: QueryFilter<User> = { role: UserRole.CUSTOMER };
    if (query.status) filter.status = query.status;
    if (query.search) filter.$or = this.searchClauses(query.search);

    const [users, total] = await Promise.all([
      this.userModel
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .exec(),
      this.userModel.countDocuments(filter).exec(),
    ]);
    const rideCounts = await this.rideModel
      .aggregate<{ _id: Types.ObjectId; count: number }>([
        { $match: { customerId: { $in: users.map((user) => user._id) } } },
        { $group: { _id: "$customerId", count: { $sum: 1 } } },
      ])
      .exec();
    const countOf = new Map(rideCounts.map((row) => [row._id.toString(), row.count]));
    return {
      items: users.map((user) => ({
        id: user._id.toString(),
        name: nameOf(user),
        phone: user.phone,
        email: user.email,
        status: user.status,
        isPhoneVerified: user.isPhoneVerified,
        totalRides: countOf.get(user._id.toString()) ?? 0,
        lastLoginAt: user.lastLoginAt,
        createdAt: user.get("createdAt") as Date,
      })),
      page: query.page,
      limit: query.limit,
      total,
      hasMore: query.page * query.limit < total,
    };
  }

  async customerDetail(customerId: string): Promise<CustomerDetail> {
    const customer = await this.getCustomer(customerId);
    const id = customer._id;
    const [byStatus, paid, outstanding, complaints, recent, active] = await Promise.all([
      this.rideModel
        .aggregate<{ _id: RideStatus; count: number }>([
          { $match: { customerId: id } },
          { $group: { _id: "$status", count: { $sum: 1 } } },
        ])
        .exec(),
      this.paymentModel
        .aggregate<{ total: number }>([
          { $match: { customerId: id, status: { $in: [PaymentStatus.CAPTURED, PaymentStatus.PARTIALLY_REFUNDED] } } },
          { $group: { _id: null, total: { $sum: "$amountPaise" } } },
        ])
        .exec(),
      this.cancellations.outstandingFor(id),
      this.ticketModel.countDocuments({ userId: id }).exec(),
      this.rideModel.find({ customerId: id }).sort({ requestedAt: -1 }).limit(10).exec(),
      this.rideModel.findOne({ customerId: id, isActive: true }).exec(),
    ]);
    const count = (status: RideStatus) => byStatus.find((row) => row._id === status)?.count ?? 0;
    return {
      customer: {
        ...this.users.toSummary(customer),
        statusReason: customer.statusReason,
        statusChangedAt: customer.statusChangedAt,
      },
      stats: {
        totalRides: byStatus.reduce((sum, row) => sum + row.count, 0),
        completedRides: count(RideStatus.COMPLETED),
        cancelledRides: count(RideStatus.CANCELLED),
        totalPaid: toRupees(paid[0]?.total ?? 0),
        outstandingCancellationFees: outstanding.amount,
        outstandingCancellationCount: outstanding.count,
        complaints,
      },
      activeRide: active ? this.views.base(active) : null,
      recentRides: recent.map((ride) => this.views.base(ride)),
    };
  }

  /**
   * ACTIVE ⇄ BLOCKED. A blocked customer is locked out at once (the access
   * guard checks account status) and every session is revoked by the caller.
   */
  async setCustomerStatus(
    customerId: string,
    status: UserStatus.ACTIVE | UserStatus.BLOCKED,
    adminUserId: string,
    reason?: string,
  ): Promise<{ customer: UserDocument; changed: boolean }> {
    const customer = await this.getCustomer(customerId);
    if (customer.status === status) return { customer, changed: false };
    if (status === UserStatus.BLOCKED && !reason)
      throw apiBadRequest("Give a reason for blocking this customer", "VALIDATION_FAILED");
    if (status === UserStatus.BLOCKED && (await this.activeRideOf(customerId)))
      throw apiConflict("This customer has a ride in progress. Cancel it before blocking the account.", "RIDE_ALREADY_ACTIVE");
    customer.status = status;
    customer.statusReason = status === UserStatus.BLOCKED ? reason : undefined;
    customer.statusChangedAt = new Date();
    customer.statusChangedBy = new Types.ObjectId(adminUserId);
    await customer.save();
    return { customer, changed: true };
  }

  private async activeRideOf(customerId: string): Promise<{ id: string; rideCode: string } | null> {
    const ride = await this.rideModel
      .findOne({ customerId: new Types.ObjectId(customerId), isActive: true })
      .select("_id rideCode")
      .lean()
      .exec();
    return ride ? { id: ride._id.toString(), rideCode: ride.rideCode } : null;
  }

  // ── Vehicles ──────────────────────────────────────────────────────────

  async vehiclePage(query: AdminVehiclesQueryDto): Promise<Page<VehicleListItem>> {
    const filter: QueryFilter<Vehicle> = {};
    if (query.vehicleType) filter.vehicleType = query.vehicleType;
    if (query.active !== undefined) filter.isActive = query.active;
    if (query.search)
      filter.registrationNumber = { $regex: escapeRegex(query.search.trim().toUpperCase().replace(/\s+/g, "")) };

    const [vehicles, total] = await Promise.all([
      this.vehicleModel
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .exec(),
      this.vehicleModel.countDocuments(filter).exec(),
    ]);
    const profiles = await this.driverModel
      .find({ _id: { $in: vehicles.map((vehicle) => vehicle.driverId) } })
      .select("driverCode driverStatus userId")
      .lean()
      .exec();
    const users = await this.userModel
      .find({ _id: { $in: profiles.map((profile) => profile.userId) } })
      .select("firstName lastName phone")
      .lean()
      .exec();
    const profileById = new Map(profiles.map((profile) => [profile._id.toString(), profile]));
    const userById = new Map(users.map((user) => [user._id.toString(), user]));
    return {
      items: vehicles.map((vehicle) => {
        const profile = profileById.get(vehicle.driverId.toString());
        const user = profile ? userById.get(profile.userId.toString()) : undefined;
        return {
          id: vehicle._id.toString(),
          vehicleType: vehicle.vehicleType,
          registrationNumber: vehicle.registrationNumber,
          make: vehicle.make,
          model: vehicle.vehicleModel,
          color: vehicle.color,
          manufactureYear: vehicle.manufactureYear,
          isActive: vehicle.isActive,
          createdAt: vehicle.get("createdAt") as Date,
          driver: profile
            ? {
                id: profile._id.toString(),
                driverCode: profile.driverCode,
                driverStatus: profile.driverStatus,
                name: nameOf(user),
                phone: user?.phone ?? "",
              }
            : null,
        };
      }),
      page: query.page,
      limit: query.limit,
      total,
      hasMore: query.page * query.limit < total,
    };
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  private async getCustomer(customerId: string): Promise<UserDocument> {
    const customer = await this.userModel.findOne({ _id: customerId, role: UserRole.CUSTOMER }).exec();
    if (!customer) throw apiNotFound("Customer not found", "CUSTOMER_NOT_FOUND");
    return customer;
  }

  private searchClauses(search: string): QueryFilter<User>[] {
    const term = escapeRegex(search.trim());
    const clauses: QueryFilter<User>[] = [
      { phone: { $regex: term } },
      { email: { $regex: term, $options: "i" } },
      { firstName: { $regex: term, $options: "i" } },
      { lastName: { $regex: term, $options: "i" } },
    ];
    // "Sachin Kumar" → first AND last name.
    const [first, ...rest] = search.trim().split(/\s+/);
    if (rest.length)
      clauses.push({
        firstName: { $regex: `^${escapeRegex(first)}`, $options: "i" },
        lastName: { $regex: `^${escapeRegex(rest.join(" "))}`, $options: "i" },
      });
    return clauses;
  }

  private async matchUsers(role: UserRole, search: string): Promise<Types.ObjectId[]> {
    const users = await this.userModel
      .find({ role, $or: this.searchClauses(search) })
      .select("_id")
      .limit(200)
      .lean()
      .exec();
    return users.map((user) => user._id);
  }
}
