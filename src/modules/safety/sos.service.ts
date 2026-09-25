import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectModel } from "@nestjs/mongoose";
import type { Model, QueryFilter } from "mongoose";
import { Types } from "mongoose";
import { apiBadRequest, apiConflict, apiNotFound } from "../../common/exceptions/api.exception";
import type { AuthenticatedUser } from "../../common/types/jwt-payload";
import { UserRole } from "../../common/types/user-role.enum";
import { generateReferenceCode } from "../../common/utils/reference-code";
import { startOfDayInTimeZone } from "../../common/utils/time";
import { DriverProfile } from "../drivers/schemas/driver-profile.schema";
import { DriverLocationService } from "../locations/driver-location.service";
import { NotificationType } from "../notifications/notification-types";
import { NotificationsService } from "../notifications/notifications.service";
import { rideNotFound } from "../rides/ride-errors";
import { Ride } from "../rides/schemas/ride.schema";
import type { RideDocument } from "../rides/schemas/ride.schema";
import type { Page } from "../rides/rides.service";
import { User } from "../users/schemas/user.schema";
import type { ListSosQueryDto, TriggerSosDto, UpdateSosDto } from "./dto/sos.dto";
import { EmergencyContactsService } from "./emergency-contacts.service";
import { SosEvent } from "./schemas/sos-event.schema";
import type { SosEventDocument, SosLocation } from "./schemas/sos-event.schema";
import { OPEN_SOS_STATUSES, SosLocationSource, SosStatus, canTransitionSos, sosAllowed } from "./sos-lifecycle";

interface PersonRef {
  id: string;
  name: string;
  phone: string;
}

/** What the person who raised the alert sees. */
export interface SosView {
  id: string;
  sosCode: string;
  rideId: string;
  status: SosStatus;
  location: { latitude: number; longitude: number; address?: string; source: SosLocationSource };
  message?: string;
  triggeredAt: Date;
  acknowledgedAt?: Date;
  resolvedAt?: Date;
  /** True: the safety team has taken the incident (acknowledged or later). */
  handled: boolean;
}

export interface SosTriggerResult {
  sos: SosView;
  /** False when an open alert already existed and was updated instead. */
  created: boolean;
}

export interface AdminSosListItem {
  id: string;
  sosCode: string;
  status: SosStatus;
  rideId: string;
  rideCode: string;
  rideStatus: string;
  raisedByRole: UserRole;
  raisedBy: PersonRef | null;
  customer: PersonRef | null;
  driver: (PersonRef & { driverCode: string }) | null;
  vehiclePlate?: string;
  vehicleType?: string;
  location: SosLocation;
  message?: string;
  triggeredAt: Date;
  acknowledgedAt?: Date;
  inProgressAt?: Date;
  resolvedAt?: Date;
  cancelledAt?: Date;
}

export interface AdminSosDetail extends AdminSosListItem {
  locationUpdates: SosLocation[];
  emergencyContacts: Array<{ name: string; phone: string; relationship?: string; isPrimary: boolean }>;
  contactsNotification: string;
  resolutionNote?: string;
  handledBy: { id: string; name: string } | null;
  timeline: Array<{ status: SosStatus; at: Date; byRole: UserRole; by: string | null; note?: string }>;
  ride: {
    id: string;
    rideCode: string;
    status: string;
    rideType: string;
    pickup: { address: string; latitude: number; longitude: number };
    destination: { address: string; latitude: number; longitude: number };
    vehicle?: { vehicleType: string; registrationNumber: string; make?: string; model?: string; color?: string };
    requestedAt: Date;
    startedAt?: Date;
    completedAt?: Date;
    cancelledAt?: Date;
  } | null;
  /** Freshest known driver position right now (live tracking). */
  driverLocation?: { latitude: number; longitude: number; updatedAt: Date };
}

export interface SosSummary {
  open: number;
  unacknowledged: number;
  acknowledged: number;
  inProgress: number;
  resolvedToday: number;
  /** Oldest unacknowledged alert — how long someone has been waiting. */
  oldestUnacknowledgedAt?: Date;
}

const isDuplicateKey = (error: unknown, index?: string): boolean =>
  typeof error === "object" &&
  error !== null &&
  (error as { code?: number }).code === 11000 &&
  (index === undefined || String((error as { message?: string }).message).includes(index));

const fullName = (user?: { firstName?: string; lastName?: string } | null): string =>
  user ? [user.firstName, user.lastName].filter(Boolean).join(" ") : "Unknown";

const STATUS_TIMESTAMP: Partial<Record<SosStatus, keyof SosEvent>> = {
  [SosStatus.ACKNOWLEDGED]: "acknowledgedAt",
  [SosStatus.IN_PROGRESS]: "inProgressAt",
  [SosStatus.RESOLVED]: "resolvedAt",
  [SosStatus.CANCELLED]: "cancelledAt",
};

/**
 * SOS incidents. NestJS decides who may raise one (a participant of an
 * eligible ride), captures where they were, freezes the ride context and
 * the user's emergency contacts, alerts every admin, and owns the incident
 * lifecycle. Incidents are never deleted.
 */
@Injectable()
export class SosService {
  private readonly logger = new Logger(SosService.name);
  private readonly graceMinutes: number;
  private readonly timeZone: string;

  constructor(
    @InjectModel(SosEvent.name) private readonly sosModel: Model<SosEvent>,
    @InjectModel(Ride.name) private readonly rideModel: Model<Ride>,
    @InjectModel(User.name) private readonly userModel: Model<User>,
    @InjectModel(DriverProfile.name) private readonly driverModel: Model<DriverProfile>,
    private readonly contacts: EmergencyContactsService,
    private readonly driverLocations: DriverLocationService,
    private readonly notifications: NotificationsService,
    config: ConfigService,
  ) {
    this.graceMinutes = config.getOrThrow<number>("sosPostRideGraceMinutes");
    this.timeZone = config.getOrThrow<string>("appTimeZone");
  }

  // ── Customer / driver ────────────────────────────────────────────────

  async trigger(user: AuthenticatedUser, rideId: string, dto: TriggerSosDto): Promise<SosTriggerResult> {
    if ((dto.latitude === undefined) !== (dto.longitude === undefined))
      throw apiBadRequest("latitude and longitude must be sent together", "VALIDATION_FAILED");

    const ride = await this.participantRide(user, rideId);
    const role = user.role === UserRole.DRIVER ? "DRIVER" : "CUSTOMER";
    if (!sosAllowed(role, ride, this.graceMinutes))
      throw apiConflict("SOS is available during an active ride", "SOS_NOT_ALLOWED");

    const location = await this.resolveLocation(ride, dto);
    const owner = new Types.ObjectId(user.userId);

    // Pressed again while an alert is open: add the new fix, keep one incident.
    const updated = await this.appendToOpen(ride._id, owner, location, dto.message);
    if (updated) return { sos: this.toView(updated), created: false };

    const contacts = await this.contacts.snapshot(owner);
    const now = new Date();
    let sos: SosEventDocument | undefined;
    for (let attempt = 0; attempt < 5 && !sos; attempt += 1) {
      try {
        sos = await this.sosModel.create({
          sosCode: generateReferenceCode("SOS"),
          rideId: ride._id,
          rideCode: ride.rideCode,
          rideStatus: ride.status,
          userId: owner,
          userRole: role === "DRIVER" ? UserRole.DRIVER : UserRole.CUSTOMER,
          customerId: ride.customerId,
          driverId: ride.driverId,
          driverUserId: ride.driverUserId,
          status: SosStatus.TRIGGERED,
          isOpen: true,
          location,
          message: dto.message,
          emergencyContacts: contacts,
          triggeredAt: now,
          timeline: [
            { status: SosStatus.TRIGGERED, at: now, byUserId: owner, byRole: role === "DRIVER" ? UserRole.DRIVER : UserRole.CUSTOMER },
          ],
        });
      } catch (error) {
        if (isDuplicateKey(error, "uniq_open_sos_per_ride_user")) {
          // A concurrent press created it first.
          const existing = await this.appendToOpen(ride._id, owner, location, dto.message);
          if (existing) return { sos: this.toView(existing), created: false };
        }
        if (!isDuplicateKey(error, "sosCode")) throw error;
      }
    }
    if (!sos) throw new Error("Could not allocate an SOS reference");

    this.logger.warn(
      `SOS ${sos.sosCode} raised by ${role} ${user.userId} on ride ${ride.rideCode} at ` +
        `${location.latitude.toFixed(5)},${location.longitude.toFixed(5)} (${location.source})`,
    );
    await this.alert(sos, ride);
    return { sos: this.toView(sos), created: true };
  }

  /** The caller's own alerts on a ride they took part in. */
  async listForRide(user: AuthenticatedUser, rideId: string): Promise<SosView[]> {
    const ride = await this.participantRide(user, rideId);
    const events = await this.sosModel
      .find({ rideId: ride._id, userId: new Types.ObjectId(user.userId) })
      .sort({ createdAt: -1 })
      .limit(20)
      .exec();
    return events.map((event) => this.toView(event));
  }

  // ── Admin ────────────────────────────────────────────────────────────

  async adminList(query: ListSosQueryDto): Promise<Page<AdminSosListItem>> {
    const filter: QueryFilter<SosEvent> = {};
    if (query.status) filter.status = query.status;
    else if (query.open) filter.isOpen = true;
    const [events, total] = await Promise.all([
      this.sosModel
        // Open alerts first, oldest waiting first among them; history newest first.
        .find(filter)
        .sort(query.open || (query.status && OPEN_SOS_STATUSES.includes(query.status)) ? { triggeredAt: 1 } : { triggeredAt: -1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .exec(),
      this.sosModel.countDocuments(filter).exec(),
    ]);
    const people = await this.people(events);
    return {
      items: events.map((event) => this.toAdminListItem(event, people)),
      page: query.page,
      limit: query.limit,
      total,
      hasMore: query.page * query.limit < total,
    };
  }

  async summary(): Promise<SosSummary> {
    const [counts, resolvedToday, oldest] = await Promise.all([
      this.sosModel
        .aggregate<{ _id: SosStatus; count: number }>([
          { $match: { isOpen: true } },
          { $group: { _id: "$status", count: { $sum: 1 } } },
        ])
        .exec(),
      this.sosModel
        .countDocuments({ status: SosStatus.RESOLVED, resolvedAt: { $gte: startOfDayInTimeZone(new Date(), this.timeZone) } })
        .exec(),
      this.sosModel.findOne({ status: SosStatus.TRIGGERED }).sort({ triggeredAt: 1 }).select("triggeredAt").lean().exec(),
    ]);
    const count = (status: SosStatus) => counts.find((row) => row._id === status)?.count ?? 0;
    return {
      open: counts.reduce((sum, row) => sum + row.count, 0),
      unacknowledged: count(SosStatus.TRIGGERED),
      acknowledged: count(SosStatus.ACKNOWLEDGED),
      inProgress: count(SosStatus.IN_PROGRESS),
      resolvedToday,
      oldestUnacknowledgedAt: oldest?.triggeredAt,
    };
  }

  async adminDetail(id: string): Promise<AdminSosDetail> {
    const sos = await this.sosModel.findById(id).exec();
    if (!sos) throw apiNotFound("SOS incident not found", "SOS_NOT_FOUND");
    return this.buildDetail(sos);
  }

  async adminUpdate(adminUserId: string, id: string, dto: UpdateSosDto): Promise<AdminSosDetail> {
    const sos = await this.sosModel.findById(id).exec();
    if (!sos) throw apiNotFound("SOS incident not found", "SOS_NOT_FOUND");
    if (!canTransitionSos(sos.status, dto.status))
      throw apiConflict(`An incident that is ${sos.status} cannot move to ${dto.status}`, "SOS_INVALID_TRANSITION");
    if ((dto.status === SosStatus.RESOLVED || dto.status === SosStatus.CANCELLED) && !dto.note)
      throw apiBadRequest("Add a note describing the outcome", "VALIDATION_FAILED");

    const now = new Date();
    const admin = new Types.ObjectId(adminUserId);
    const set: Record<string, unknown> = {
      status: dto.status,
      isOpen: OPEN_SOS_STATUSES.includes(dto.status),
      adminId: admin,
    };
    const stamp = STATUS_TIMESTAMP[dto.status];
    if (stamp) set[stamp] = now;
    // Skipping ahead still records when it was first acknowledged.
    if (dto.status !== SosStatus.ACKNOWLEDGED && !sos.acknowledgedAt) set.acknowledgedAt = now;
    if (dto.status === SosStatus.RESOLVED || dto.status === SosStatus.CANCELLED) set.resolutionNote = dto.note;

    // Compare-and-set: two admins acting at once cannot both move it.
    const updated = await this.sosModel
      .findOneAndUpdate(
        { _id: sos._id, status: sos.status },
        {
          $set: set,
          $push: { timeline: { status: dto.status, at: now, byUserId: admin, byRole: UserRole.ADMIN, note: dto.note } },
        },
        { returnDocument: "after", runValidators: true },
      )
      .exec();
    if (!updated)
      throw apiConflict("This incident was just updated by someone else — reload it", "SOS_INVALID_TRANSITION");

    this.logger.log(`SOS ${updated.sosCode}: ${sos.status} → ${dto.status} by admin ${adminUserId}`);
    await this.notifyRaiser(updated);
    return this.buildDetail(updated);
  }

  // ── Internals ────────────────────────────────────────────────────────

  /** The ride, if the caller is its customer or its driver; else 404. */
  private async participantRide(user: AuthenticatedUser, rideId: string): Promise<RideDocument> {
    const caller = new Types.ObjectId(user.userId);
    const scope: QueryFilter<Ride> =
      user.role === UserRole.DRIVER ? { driverUserId: caller } : { customerId: caller };
    const ride = await this.rideModel.findOne({ _id: new Types.ObjectId(rideId), ...scope }).exec();
    if (!ride) throw rideNotFound();
    return ride;
  }

  private async resolveLocation(ride: RideDocument, dto: TriggerSosDto): Promise<SosLocation> {
    const capturedAt = new Date();
    if (dto.latitude !== undefined && dto.longitude !== undefined)
      return {
        latitude: dto.latitude,
        longitude: dto.longitude,
        accuracyMeters: dto.accuracyMeters,
        address: dto.address,
        source: SosLocationSource.DEVICE,
        capturedAt,
      };
    if (ride.driverId) {
      const last = await this.driverLocations.lastKnown(ride.driverId);
      if (last)
        return {
          latitude: last.latitude,
          longitude: last.longitude,
          source: SosLocationSource.DRIVER_LAST_KNOWN,
          capturedAt: last.updatedAt,
        };
    }
    return {
      latitude: ride.pickup.latitude,
      longitude: ride.pickup.longitude,
      address: ride.pickup.address,
      source: SosLocationSource.RIDE_PICKUP,
      capturedAt,
    };
  }

  private async appendToOpen(
    rideId: Types.ObjectId,
    userId: Types.ObjectId,
    location: SosLocation,
    message?: string,
  ): Promise<SosEventDocument | null> {
    return this.sosModel
      .findOneAndUpdate(
        { rideId, userId, isOpen: true },
        {
          $push: { locationUpdates: { $each: [location], $slice: -50 } },
          ...(message ? { $set: { message } } : {}),
        },
        { returnDocument: "after" },
      )
      .exec();
  }

  private async alert(sos: SosEventDocument, ride: RideDocument): Promise<void> {
    const raiser = await this.userModel.findById(sos.userId).select("firstName lastName").lean().exec();
    const who = sos.userRole === UserRole.DRIVER ? "Driver" : "Customer";
    await Promise.all([
      this.notifications.notifyAdmins({
        type: NotificationType.SOS_CREATED,
        title: `🚨 SOS ${sos.sosCode}`,
        message: `${who} ${fullName(raiser)} raised an SOS on ride ${ride.rideCode}. Respond now.`,
        rideId: ride._id.toString(),
        referenceId: sos._id.toString(),
        data: { sosId: sos._id.toString(), sosCode: sos.sosCode, rideId: ride._id.toString() },
        dedupeKey: `sos:${sos._id.toString()}:created`,
      }),
      // Confirmation to the person who pressed it. The other party is
      // deliberately NOT notified: telling a threatening person that an
      // alert was raised could escalate the danger.
      this.notifications.notify([
        {
          userId: sos.userId.toString(),
          recipientRole: sos.userRole,
          type: NotificationType.SOS_CREATED,
          title: "Emergency alert sent",
          message: `The Tirvona safety team has been alerted (${sos.sosCode}). If you are in immediate danger, call 112.`,
          rideId: ride._id.toString(),
          referenceId: sos._id.toString(),
          data: { sosId: sos._id.toString(), sosCode: sos.sosCode, rideId: ride._id.toString() },
          dedupeKey: `sos:${sos._id.toString()}:confirm`,
        },
      ]),
    ]);
  }

  private async notifyRaiser(sos: SosEventDocument): Promise<void> {
    const message: Partial<Record<SosStatus, string>> = {
      [SosStatus.ACKNOWLEDGED]: "The Tirvona safety team is looking into your alert and will contact you.",
      [SosStatus.IN_PROGRESS]: "The Tirvona safety team is handling your alert.",
      [SosStatus.RESOLVED]: "Your safety alert has been resolved. Thank you for letting us know.",
      [SosStatus.CANCELLED]: "Your safety alert has been closed by the safety team.",
    };
    const text = message[sos.status];
    if (!text) return;
    await this.notifications.notify([
      {
        userId: sos.userId.toString(),
        recipientRole: sos.userRole,
        type: NotificationType.SOS_UPDATED,
        title: `Safety alert ${sos.sosCode}`,
        message: text,
        rideId: sos.rideId.toString(),
        referenceId: sos._id.toString(),
        data: { sosId: sos._id.toString(), sosCode: sos.sosCode, rideId: sos.rideId.toString(), status: sos.status },
        dedupeKey: `sos:${sos._id.toString()}:${sos.status}`,
      },
    ]);
  }

  private async people(events: SosEventDocument[]) {
    const userIds = new Set<string>();
    const driverIds = new Set<string>();
    const rideIds = new Set<string>();
    for (const event of events) {
      userIds.add(event.userId.toString());
      userIds.add(event.customerId.toString());
      if (event.driverUserId) userIds.add(event.driverUserId.toString());
      if (event.driverId) driverIds.add(event.driverId.toString());
      if (event.adminId) userIds.add(event.adminId.toString());
      rideIds.add(event.rideId.toString());
    }
    const [users, drivers, rides] = await Promise.all([
      this.userModel
        .find({ _id: { $in: [...userIds].map((id) => new Types.ObjectId(id)) } })
        .select("firstName lastName phone")
        .lean()
        .exec(),
      this.driverModel
        .find({ _id: { $in: [...driverIds].map((id) => new Types.ObjectId(id)) } })
        .select("driverCode")
        .lean()
        .exec(),
      this.rideModel
        .find({ _id: { $in: [...rideIds].map((id) => new Types.ObjectId(id)) } })
        .select("status vehicle")
        .lean()
        .exec(),
    ]);
    return {
      users: new Map(users.map((user) => [user._id.toString(), user])),
      drivers: new Map(drivers.map((driver) => [driver._id.toString(), driver])),
      rides: new Map(rides.map((ride) => [ride._id.toString(), ride])),
    };
  }

  private toAdminListItem(event: SosEventDocument, people: Awaited<ReturnType<SosService["people"]>>): AdminSosListItem {
    const person = (id?: Types.ObjectId): PersonRef | null => {
      const user = id ? people.users.get(id.toString()) : undefined;
      return user ? { id: user._id.toString(), name: fullName(user), phone: user.phone } : null;
    };
    const driverUser = person(event.driverUserId);
    const driverProfile = event.driverId ? people.drivers.get(event.driverId.toString()) : undefined;
    const ride = people.rides.get(event.rideId.toString());
    return {
      id: event._id.toString(),
      sosCode: event.sosCode,
      status: event.status,
      rideId: event.rideId.toString(),
      rideCode: event.rideCode,
      rideStatus: ride?.status ?? event.rideStatus,
      raisedByRole: event.userRole,
      raisedBy: person(event.userId),
      customer: person(event.customerId),
      driver: driverUser ? { ...driverUser, driverCode: driverProfile?.driverCode ?? "—" } : null,
      vehiclePlate: ride?.vehicle?.registrationNumber,
      vehicleType: ride?.vehicle?.vehicleType,
      location: event.location,
      message: event.message,
      triggeredAt: event.triggeredAt,
      acknowledgedAt: event.acknowledgedAt,
      inProgressAt: event.inProgressAt,
      resolvedAt: event.resolvedAt,
      cancelledAt: event.cancelledAt,
    };
  }

  private async buildDetail(sos: SosEventDocument): Promise<AdminSosDetail> {
    const people = await this.people([sos]);
    const base = this.toAdminListItem(sos, people);
    const ride = await this.rideModel.findById(sos.rideId).exec();
    const timelineUsers = await this.userModel
      .find({ _id: { $in: sos.timeline.map((entry) => entry.byUserId).filter(Boolean) } })
      .select("firstName lastName")
      .lean()
      .exec();
    const names = new Map(timelineUsers.map((user) => [user._id.toString(), fullName(user)]));
    const admin = sos.adminId ? people.users.get(sos.adminId.toString()) : undefined;
    const driverLocation =
      sos.driverId && sos.isOpen ? await this.driverLocations.lastKnown(sos.driverId) : undefined;
    return {
      ...base,
      locationUpdates: sos.locationUpdates,
      emergencyContacts: sos.emergencyContacts.map((contact) => ({
        name: contact.name,
        phone: contact.phone,
        relationship: contact.relationship,
        isPrimary: contact.isPrimary,
      })),
      contactsNotification: sos.contactsNotification,
      resolutionNote: sos.resolutionNote,
      handledBy: admin ? { id: admin._id.toString(), name: fullName(admin) } : null,
      timeline: sos.timeline.map((entry) => ({
        status: entry.status,
        at: entry.at,
        byRole: entry.byRole,
        by: entry.byUserId ? (names.get(entry.byUserId.toString()) ?? null) : null,
        note: entry.note,
      })),
      ride: ride
        ? {
            id: ride._id.toString(),
            rideCode: ride.rideCode,
            status: ride.status,
            rideType: ride.rideType,
            pickup: { address: ride.pickup.address, latitude: ride.pickup.latitude, longitude: ride.pickup.longitude },
            destination: {
              address: ride.destination.address,
              latitude: ride.destination.latitude,
              longitude: ride.destination.longitude,
            },
            vehicle: ride.vehicle
              ? {
                  vehicleType: ride.vehicle.vehicleType,
                  registrationNumber: ride.vehicle.registrationNumber,
                  make: ride.vehicle.make,
                  model: ride.vehicle.model,
                  color: ride.vehicle.color,
                }
              : undefined,
            requestedAt: ride.requestedAt,
            startedAt: ride.startedAt,
            completedAt: ride.completedAt,
            cancelledAt: ride.cancelledAt,
          }
        : null,
      driverLocation: driverLocation
        ? { latitude: driverLocation.latitude, longitude: driverLocation.longitude, updatedAt: driverLocation.updatedAt }
        : undefined,
    };
  }

  private toView(sos: SosEventDocument): SosView {
    const latest = sos.locationUpdates.at(-1) ?? sos.location;
    return {
      id: sos._id.toString(),
      sosCode: sos.sosCode,
      rideId: sos.rideId.toString(),
      status: sos.status,
      location: {
        latitude: latest.latitude,
        longitude: latest.longitude,
        address: latest.address,
        source: latest.source,
      },
      message: sos.message,
      triggeredAt: sos.triggeredAt,
      acknowledgedAt: sos.acknowledgedAt,
      resolvedAt: sos.resolvedAt,
      handled: sos.status !== SosStatus.TRIGGERED,
    };
  }
}
