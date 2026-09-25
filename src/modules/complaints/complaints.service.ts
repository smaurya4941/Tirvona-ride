import { HttpStatus, Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import type { Model, QueryFilter } from "mongoose";
import { Types } from "mongoose";
import { ApiException, apiBadRequest, apiConflict, apiNotFound } from "../../common/exceptions/api.exception";
import type { AuthenticatedUser } from "../../common/types/jwt-payload";
import { UserRole } from "../../common/types/user-role.enum";
import { generateReferenceCode } from "../../common/utils/reference-code";
import { DriverProfile } from "../drivers/schemas/driver-profile.schema";
import { NotificationType } from "../notifications/notification-types";
import { NotificationsService } from "../notifications/notifications.service";
import { Ride } from "../rides/schemas/ride.schema";
import type { RideDocument } from "../rides/schemas/ride.schema";
import type { Page } from "../rides/rides.service";
import { User } from "../users/schemas/user.schema";
import {
  ComplaintPriority,
  ComplaintStatus,
  OPEN_COMPLAINT_STATUSES,
  RIDE_REQUIRED_CATEGORIES,
  canTransitionComplaint,
  categoryAllowed,
  initialPriority,
} from "./complaint-rules";
import type { ComplaintCategory } from "./complaint-rules";
import type {
  AdminListComplaintsQueryDto,
  CreateComplaintDto,
  ListComplaintsQueryDto,
  UpdateComplaintDto,
} from "./dto/complaint.dto";
import { SupportTicket } from "./schemas/support-ticket.schema";
import type { SupportTicketDocument } from "./schemas/support-ticket.schema";

interface PersonRef {
  id: string;
  name: string;
  phone: string;
}

/** What the person who filed it sees — no internal notes, no priority. */
export interface ComplaintView {
  id: string;
  ticketCode: string;
  category: ComplaintCategory;
  subject: string;
  description: string;
  status: ComplaintStatus;
  rideId?: string;
  rideCode?: string;
  resolution?: string;
  createdAt: Date;
  updatedAt: Date;
  resolvedAt?: Date;
  closedAt?: Date;
  timeline: Array<{ status: ComplaintStatus; at: Date }>;
}

export interface AdminComplaintView extends Omit<ComplaintView, "timeline"> {
  priority: ComplaintPriority;
  userRole: UserRole;
  user: PersonRef | null;
  customer: PersonRef | null;
  driver: (PersonRef & { driverId: string; driverCode: string }) | null;
  assignedAdmin: { id: string; name: string } | null;
}

export interface AdminComplaintDetail extends AdminComplaintView {
  ride: {
    id: string;
    rideCode: string;
    status: string;
    rideType: string;
    pickupAddress: string;
    destinationAddress: string;
    finalFare?: number;
    estimatedFare: number;
    paymentStatus: string;
    requestedAt: Date;
    completedAt?: Date;
  } | null;
  history: Array<{ at: Date; action: string; status?: ComplaintStatus; note?: string; byRole: UserRole; by: string | null }>;
}

export interface ComplaintSummary {
  open: number;
  inReview: number;
  urgentOpen: number;
  resolvedToday: number;
}

const fullName = (user?: { firstName?: string; lastName?: string } | null): string =>
  user ? [user.firstName, user.lastName].filter(Boolean).join(" ") : "Unknown";

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const STATUS_LABEL: Record<ComplaintStatus, string> = {
  [ComplaintStatus.OPEN]: "open",
  [ComplaintStatus.IN_REVIEW]: "being reviewed",
  [ComplaintStatus.RESOLVED]: "resolved",
  [ComplaintStatus.CLOSED]: "closed",
};

const notFound = () => apiNotFound("Complaint not found", "COMPLAINT_NOT_FOUND");

/**
 * Complaints / support tickets. Customers and drivers file them (optionally
 * about a ride they took part in); admins triage, review and resolve them.
 * The user sees status and the resolution; internal notes stay internal.
 */
@Injectable()
export class ComplaintsService {
  constructor(
    @InjectModel(SupportTicket.name) private readonly ticketModel: Model<SupportTicket>,
    @InjectModel(Ride.name) private readonly rideModel: Model<Ride>,
    @InjectModel(User.name) private readonly userModel: Model<User>,
    @InjectModel(DriverProfile.name) private readonly driverModel: Model<DriverProfile>,
    private readonly notifications: NotificationsService,
  ) {}

  // ── Customer / driver ────────────────────────────────────────────────

  async create(user: AuthenticatedUser, dto: CreateComplaintDto): Promise<ComplaintView> {
    if (!categoryAllowed(user.role, dto.category))
      throw apiBadRequest("This category is not available for your account", "COMPLAINT_NOT_ALLOWED");
    if (!dto.rideId && RIDE_REQUIRED_CATEGORIES.includes(dto.category))
      throw apiBadRequest("Choose the ride this is about", "VALIDATION_FAILED");

    const owner = new Types.ObjectId(user.userId);
    const ride = dto.rideId ? await this.participantRide(user, dto.rideId) : undefined;

    if (ride) {
      const open = await this.ticketModel
        .findOne({ userId: owner, rideId: ride._id, category: dto.category, status: { $in: OPEN_COMPLAINT_STATUSES } })
        .select("_id ticketCode")
        .lean()
        .exec();
      if (open)
        throw new ApiException(
          HttpStatus.CONFLICT,
          `You already have an open complaint about this ride (${open.ticketCode})`,
          "COMPLAINT_ALREADY_OPEN",
          { id: open._id.toString(), ticketCode: open.ticketCode },
        );
    }

    const now = new Date();
    let ticket: SupportTicketDocument | undefined;
    for (let attempt = 0; attempt < 5 && !ticket; attempt += 1) {
      try {
        ticket = await this.ticketModel.create({
          ticketCode: generateReferenceCode("TKT"),
          userId: owner,
          userRole: user.role,
          rideId: ride?._id,
          rideCode: ride?.rideCode,
          customerId: ride?.customerId,
          driverId: ride?.driverId,
          category: dto.category,
          subject: dto.subject,
          description: dto.description,
          status: ComplaintStatus.OPEN,
          priority: initialPriority(dto.category),
          history: [{ at: now, byUserId: owner, byRole: user.role, action: "CREATED", status: ComplaintStatus.OPEN }],
        });
      } catch (error) {
        if ((error as { code?: number }).code !== 11000) throw error;
      }
    }
    if (!ticket) throw new Error("Could not allocate a ticket reference");

    await Promise.all([
      this.notifications.notify([
        {
          userId: user.userId,
          recipientRole: user.role,
          type: NotificationType.COMPLAINT_CREATED,
          title: "We've received your complaint",
          message: `Ticket ${ticket.ticketCode}: our support team will review it and update you here.`,
          rideId: ride?._id.toString(),
          referenceId: ticket._id.toString(),
          data: { complaintId: ticket._id.toString(), ticketCode: ticket.ticketCode },
          dedupeKey: `complaint:${ticket._id.toString()}:created`,
        },
      ]),
      this.notifications.notifyAdmins({
        type: NotificationType.COMPLAINT_CREATED,
        title: `New ${ticket.priority === ComplaintPriority.URGENT ? "URGENT " : ""}complaint ${ticket.ticketCode}`,
        message: `${dto.subject}${ride ? ` · ride ${ride.rideCode}` : ""}`,
        rideId: ride?._id.toString(),
        referenceId: ticket._id.toString(),
        data: { complaintId: ticket._id.toString(), ticketCode: ticket.ticketCode },
        dedupeKey: `complaint:${ticket._id.toString()}:admin`,
      }),
    ]);
    return this.toView(ticket);
  }

  async listMine(user: AuthenticatedUser, query: ListComplaintsQueryDto): Promise<Page<ComplaintView>> {
    const filter: QueryFilter<SupportTicket> = { userId: new Types.ObjectId(user.userId) };
    if (query.status) filter.status = query.status;
    const [tickets, total] = await Promise.all([
      this.ticketModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .exec(),
      this.ticketModel.countDocuments(filter).exec(),
    ]);
    return {
      items: tickets.map((ticket) => this.toView(ticket)),
      page: query.page,
      limit: query.limit,
      total,
      hasMore: query.page * query.limit < total,
    };
  }

  async getMine(user: AuthenticatedUser, id: string): Promise<ComplaintView> {
    const ticket = await this.ticketModel
      .findOne({ _id: new Types.ObjectId(id), userId: new Types.ObjectId(user.userId) })
      .exec();
    if (!ticket) throw notFound();
    return this.toView(ticket);
  }

  // ── Admin ────────────────────────────────────────────────────────────

  async adminList(query: AdminListComplaintsQueryDto): Promise<Page<AdminComplaintView>> {
    const filter: QueryFilter<SupportTicket> = {};
    if (query.status) filter.status = query.status;
    if (query.category) filter.category = query.category;
    if (query.priority) filter.priority = query.priority;
    if (query.search) {
      const term = query.search.trim();
      const pattern = { $regex: `^${escapeRegex(term.toUpperCase())}` };
      const users = await this.userModel
        .find({
          $or: [
            { phone: { $regex: escapeRegex(term) } },
            { firstName: { $regex: `^${escapeRegex(term)}`, $options: "i" } },
          ],
        })
        .select("_id")
        .limit(200)
        .lean()
        .exec();
      filter.$or = [
        { ticketCode: pattern },
        { rideCode: pattern },
        { userId: { $in: users.map((row) => row._id) } },
      ];
    }
    const [tickets, total] = await Promise.all([
      this.ticketModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .exec(),
      this.ticketModel.countDocuments(filter).exec(),
    ]);
    const people = await this.people(tickets);
    return {
      items: tickets.map((ticket) => this.toAdminView(ticket, people)),
      page: query.page,
      limit: query.limit,
      total,
      hasMore: query.page * query.limit < total,
    };
  }

  async summary(timeZoneDayStart: Date): Promise<ComplaintSummary> {
    const [open, inReview, urgentOpen, resolvedToday] = await Promise.all([
      this.ticketModel.countDocuments({ status: ComplaintStatus.OPEN }).exec(),
      this.ticketModel.countDocuments({ status: ComplaintStatus.IN_REVIEW }).exec(),
      this.ticketModel
        .countDocuments({ status: { $in: OPEN_COMPLAINT_STATUSES }, priority: ComplaintPriority.URGENT })
        .exec(),
      this.ticketModel.countDocuments({ resolvedAt: { $gte: timeZoneDayStart } }).exec(),
    ]);
    return { open, inReview, urgentOpen, resolvedToday };
  }

  async adminDetail(id: string): Promise<AdminComplaintDetail> {
    const ticket = await this.ticketModel.findById(id).exec();
    if (!ticket) throw notFound();
    return this.buildDetail(ticket);
  }

  async adminUpdate(adminUserId: string, id: string, dto: UpdateComplaintDto): Promise<AdminComplaintDetail> {
    const ticket = await this.ticketModel.findById(id).exec();
    if (!ticket) throw notFound();
    if (dto.status === undefined && dto.priority === undefined && !dto.note && !dto.assignToMe && !dto.resolution)
      throw apiBadRequest("Nothing to update", "VALIDATION_FAILED");

    const admin = new Types.ObjectId(adminUserId);
    const now = new Date();
    const set: Record<string, unknown> = {};
    const history: Array<Record<string, unknown>> = [];
    const statusChanged = dto.status !== undefined && dto.status !== ticket.status;

    if (statusChanged) {
      if (!canTransitionComplaint(ticket.status, dto.status!))
        throw apiConflict(
          `A ${ticket.status} complaint cannot move to ${dto.status}`,
          "COMPLAINT_INVALID_TRANSITION",
        );
      if (dto.status === ComplaintStatus.RESOLVED && !dto.resolution && !ticket.resolution)
        throw apiBadRequest("Add a resolution the user will see", "VALIDATION_FAILED");
      set.status = dto.status;
      if (dto.status === ComplaintStatus.RESOLVED) set.resolvedAt = now;
      if (dto.status === ComplaintStatus.CLOSED) set.closedAt = now;
      history.push({ at: now, byUserId: admin, byRole: UserRole.ADMIN, action: "STATUS", status: dto.status, note: dto.note });
    } else if (dto.note) {
      history.push({ at: now, byUserId: admin, byRole: UserRole.ADMIN, action: "NOTE", note: dto.note });
    }
    if (dto.resolution) set.resolution = dto.resolution;
    if (dto.priority && dto.priority !== ticket.priority) {
      set.priority = dto.priority;
      history.push({ at: now, byUserId: admin, byRole: UserRole.ADMIN, action: `PRIORITY_${dto.priority}` });
    }
    // Acting on a ticket (or asking to) makes the admin its owner.
    if (dto.assignToMe || statusChanged) set.assignedAdminId = admin;
    if (dto.assignToMe && !ticket.assignedAdminId?.equals(admin))
      history.push({ at: now, byUserId: admin, byRole: UserRole.ADMIN, action: "ASSIGNED" });

    // Compare-and-set on the status the admin was looking at.
    const updated = await this.ticketModel
      .findOneAndUpdate(
        { _id: ticket._id, status: ticket.status },
        { $set: set, ...(history.length ? { $push: { history: { $each: history } } } : {}) },
        { returnDocument: "after", runValidators: true },
      )
      .exec();
    if (!updated)
      throw apiConflict("This complaint was just updated by someone else — reload it", "COMPLAINT_INVALID_TRANSITION");

    if (statusChanged) {
      await this.notifications.notify([
        {
          userId: updated.userId.toString(),
          recipientRole: updated.userRole,
          type: NotificationType.COMPLAINT_UPDATED,
          title: `Complaint ${updated.ticketCode} ${STATUS_LABEL[updated.status]}`,
          message:
            updated.status === ComplaintStatus.RESOLVED && updated.resolution
              ? updated.resolution
              : `Your complaint "${updated.subject}" is now ${STATUS_LABEL[updated.status]}.`,
          rideId: updated.rideId?.toString(),
          referenceId: updated._id.toString(),
          data: { complaintId: updated._id.toString(), ticketCode: updated.ticketCode, status: updated.status },
          dedupeKey: `complaint:${updated._id.toString()}:${updated.status}:${now.getTime()}`,
        },
      ]);
    }
    return this.buildDetail(updated);
  }

  // ── Internals ────────────────────────────────────────────────────────

  /** A ride the caller took part in (a driver: only rides they accepted). */
  private async participantRide(user: AuthenticatedUser, rideId: string): Promise<RideDocument> {
    const caller = new Types.ObjectId(user.userId);
    const scope: QueryFilter<Ride> =
      user.role === UserRole.DRIVER ? { driverUserId: caller, acceptedAt: { $exists: true } } : { customerId: caller };
    const ride = await this.rideModel.findOne({ _id: new Types.ObjectId(rideId), ...scope }).exec();
    if (!ride) throw apiNotFound("Ride not found", "RIDE_NOT_FOUND");
    return ride;
  }

  private async people(tickets: SupportTicketDocument[]) {
    const userIds = new Set<string>();
    const driverIds = new Set<string>();
    for (const ticket of tickets) {
      userIds.add(ticket.userId.toString());
      if (ticket.customerId) userIds.add(ticket.customerId.toString());
      if (ticket.assignedAdminId) userIds.add(ticket.assignedAdminId.toString());
      if (ticket.driverId) driverIds.add(ticket.driverId.toString());
    }
    const drivers = await this.driverModel
      .find({ _id: { $in: [...driverIds].map((id) => new Types.ObjectId(id)) } })
      .select("userId driverCode")
      .lean()
      .exec();
    for (const driver of drivers) userIds.add(driver.userId.toString());
    const users = await this.userModel
      .find({ _id: { $in: [...userIds].map((id) => new Types.ObjectId(id)) } })
      .select("firstName lastName phone")
      .lean()
      .exec();
    return {
      users: new Map(users.map((user) => [user._id.toString(), user])),
      drivers: new Map(drivers.map((driver) => [driver._id.toString(), driver])),
    };
  }

  private toAdminView(
    ticket: SupportTicketDocument,
    people: Awaited<ReturnType<ComplaintsService["people"]>>,
  ): AdminComplaintView {
    const person = (id?: Types.ObjectId): PersonRef | null => {
      const user = id ? people.users.get(id.toString()) : undefined;
      return user ? { id: user._id.toString(), name: fullName(user), phone: user.phone } : null;
    };
    const driverProfile = ticket.driverId ? people.drivers.get(ticket.driverId.toString()) : undefined;
    const driverUser = driverProfile ? person(driverProfile.userId) : null;
    const admin = ticket.assignedAdminId ? people.users.get(ticket.assignedAdminId.toString()) : undefined;
    const base: Omit<ComplaintView, "timeline"> & { timeline?: unknown } = this.toView(ticket);
    delete base.timeline;
    return {
      ...base,
      priority: ticket.priority,
      userRole: ticket.userRole,
      user: person(ticket.userId),
      customer: person(ticket.customerId),
      driver:
        driverUser && driverProfile
          ? { ...driverUser, driverId: driverProfile._id.toString(), driverCode: driverProfile.driverCode }
          : null,
      assignedAdmin: admin ? { id: admin._id.toString(), name: fullName(admin) } : null,
    };
  }

  private async buildDetail(ticket: SupportTicketDocument): Promise<AdminComplaintDetail> {
    const people = await this.people([ticket]);
    const ride = ticket.rideId ? await this.rideModel.findById(ticket.rideId).exec() : null;
    const actorIds = ticket.history.map((entry) => entry.byUserId).filter((id): id is Types.ObjectId => Boolean(id));
    const actors = await this.userModel.find({ _id: { $in: actorIds } }).select("firstName lastName").lean().exec();
    const names = new Map(actors.map((user) => [user._id.toString(), fullName(user)]));
    return {
      ...this.toAdminView(ticket, people),
      ride: ride
        ? {
            id: ride._id.toString(),
            rideCode: ride.rideCode,
            status: ride.status,
            rideType: ride.rideType,
            pickupAddress: ride.pickup.address,
            destinationAddress: ride.destination.address,
            finalFare: ride.fare.finalFare,
            estimatedFare: ride.fare.estimatedFare,
            paymentStatus: ride.paymentStatus,
            requestedAt: ride.requestedAt,
            completedAt: ride.completedAt,
          }
        : null,
      history: ticket.history.map((entry) => ({
        at: entry.at,
        action: entry.action,
        status: entry.status,
        note: entry.note,
        byRole: entry.byRole,
        by: entry.byUserId ? (names.get(entry.byUserId.toString()) ?? null) : null,
      })),
    };
  }

  private toView(ticket: SupportTicketDocument): ComplaintView {
    return {
      id: ticket._id.toString(),
      ticketCode: ticket.ticketCode,
      category: ticket.category,
      subject: ticket.subject,
      description: ticket.description,
      status: ticket.status,
      rideId: ticket.rideId?.toString(),
      rideCode: ticket.rideCode,
      resolution: ticket.resolution,
      createdAt: ticket.createdAt,
      updatedAt: ticket.updatedAt,
      resolvedAt: ticket.resolvedAt,
      closedAt: ticket.closedAt,
      timeline: ticket.history
        .filter((entry) => entry.status !== undefined)
        .map((entry) => ({ status: entry.status!, at: entry.at })),
    };
  }
}
