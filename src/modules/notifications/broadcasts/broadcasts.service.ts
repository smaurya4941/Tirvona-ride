import { Injectable, Logger } from "@nestjs/common";
import type { OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectModel } from "@nestjs/mongoose";
import type { Model, QueryFilter } from "mongoose";
import { Types } from "mongoose";
import { apiBadRequest, apiConflict, apiNotFound } from "../../../common/exceptions/api.exception";
import { UserRole } from "../../../common/types/user-role.enum";
import { DriverProfile, DriverStatus } from "../../drivers/schemas/driver-profile.schema";
import type { Page } from "../../rides/rides.service";
import { User, UserStatus } from "../../users/schemas/user.schema";
import type { NotificationDraft } from "../notification-plan";
import { NotificationType } from "../notification-types";
import { NotificationsService } from "../notifications.service";
import type { CreateBroadcastDto, UpdateBroadcastDto } from "./broadcast.dto";
import { Broadcast, BroadcastAudience, BroadcastStatus } from "./broadcast.schema";
import type { BroadcastDeepLink, BroadcastDocument } from "./broadcast.schema";

export interface BroadcastView {
  id: string;
  title: string;
  message: string;
  audience: BroadcastAudience;
  deepLink: BroadcastDeepLink;
  status: BroadcastStatus;
  scheduledAt?: Date;
  startedAt?: Date;
  sentAt?: Date;
  processedCount: number;
  error?: string;
  createdBy: string;
  createdByName?: string;
  sentBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

interface Recipient {
  userId: Types.ObjectId;
  role: UserRole;
}

const LEASE_MS = 120_000;
const EDITABLE: readonly BroadcastStatus[] = [BroadcastStatus.DRAFT, BroadcastStatus.SCHEDULED];

@Injectable()
export class BroadcastsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BroadcastsService.name);
  private readonly batchSize: number;
  private readonly workerIntervalMs: number;
  private timer?: NodeJS.Timeout;
  private readonly running = new Set<Promise<void>>();

  constructor(
    @InjectModel(Broadcast.name) private readonly broadcastModel: Model<Broadcast>,
    @InjectModel(User.name) private readonly userModel: Model<User>,
    @InjectModel(DriverProfile.name) private readonly driverModel: Model<DriverProfile>,
    private readonly notifications: NotificationsService,
    config: ConfigService,
  ) {
    this.batchSize = config.getOrThrow<number>("broadcastBatchSize");
    this.workerIntervalMs = config.getOrThrow<number>("broadcastWorkerIntervalMs");
  }

  onModuleInit(): void {
    if (this.workerIntervalMs > 0) {
      this.timer = setInterval(() => void this.runDue(), this.workerIntervalMs);
      this.timer.unref();
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  // ── Views ─────────────────────────────────────────────────────────────

  toView(broadcast: BroadcastDocument, createdByName?: string): BroadcastView {
    return {
      id: broadcast._id.toString(),
      title: broadcast.title,
      message: broadcast.message,
      audience: broadcast.audience,
      deepLink: broadcast.deepLink,
      status: broadcast.status,
      scheduledAt: broadcast.scheduledAt,
      startedAt: broadcast.startedAt,
      sentAt: broadcast.sentAt,
      processedCount: broadcast.processedCount,
      error: broadcast.error,
      createdBy: broadcast.createdBy.toString(),
      createdByName,
      sentBy: broadcast.sentBy?.toString(),
      createdAt: broadcast.get("createdAt") as Date,
      updatedAt: broadcast.get("updatedAt") as Date,
    };
  }

  async list(query: { page: number; limit: number; status?: BroadcastStatus }): Promise<Page<BroadcastView>> {
    const filter: QueryFilter<Broadcast> = query.status ? { status: query.status } : {};
    const [rows, total] = await Promise.all([
      this.broadcastModel
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .exec(),
      this.broadcastModel.countDocuments(filter).exec(),
    ]);
    const admins = await this.userModel
      .find({ _id: { $in: rows.map((row) => row.createdBy) } })
      .select("firstName lastName")
      .lean()
      .exec();
    const names = new Map(admins.map((admin) => [admin._id.toString(), [admin.firstName, admin.lastName].filter(Boolean).join(" ")]));
    return {
      items: rows.map((row) => this.toView(row, names.get(row.createdBy.toString()))),
      page: query.page,
      limit: query.limit,
      total,
      hasMore: query.page * query.limit < total,
    };
  }

  async get(id: string): Promise<BroadcastDocument> {
    const broadcast = await this.broadcastModel.findById(id).exec();
    if (!broadcast) throw apiNotFound("Broadcast not found", "BROADCAST_NOT_FOUND");
    return broadcast;
  }

  // ── Drafts & scheduling ───────────────────────────────────────────────

  async create(dto: CreateBroadcastDto, adminUserId: string): Promise<BroadcastDocument> {
    if (dto.scheduledAt) this.assertFuture(dto.scheduledAt);
    return this.broadcastModel.create({
      title: dto.title,
      message: dto.message,
      audience: dto.audience,
      deepLink: dto.deepLink,
      scheduledAt: dto.scheduledAt,
      status: dto.scheduledAt ? BroadcastStatus.SCHEDULED : BroadcastStatus.DRAFT,
      createdBy: new Types.ObjectId(adminUserId),
      updatedBy: new Types.ObjectId(adminUserId),
    });
  }

  async update(id: string, dto: UpdateBroadcastDto, adminUserId: string): Promise<BroadcastDocument> {
    const broadcast = await this.get(id);
    if (!EDITABLE.includes(broadcast.status))
      throw apiConflict("Only drafts and scheduled broadcasts can be edited", "BROADCAST_NOT_EDITABLE");
    if (dto.title !== undefined) broadcast.title = dto.title;
    if (dto.message !== undefined) broadcast.message = dto.message;
    if (dto.audience !== undefined) broadcast.audience = dto.audience;
    if (dto.deepLink !== undefined) broadcast.deepLink = dto.deepLink;
    if (dto.scheduledAt === null) {
      broadcast.scheduledAt = undefined;
      broadcast.status = BroadcastStatus.DRAFT;
    } else if (dto.scheduledAt !== undefined) {
      this.assertFuture(dto.scheduledAt);
      broadcast.scheduledAt = dto.scheduledAt;
      broadcast.status = BroadcastStatus.SCHEDULED;
    }
    broadcast.updatedBy = new Types.ObjectId(adminUserId);
    // Conditional save: a scheduled send may have claimed it meanwhile.
    const saved = await this.broadcastModel
      .findOneAndUpdate(
        { _id: broadcast._id, status: { $in: EDITABLE } },
        {
          $set: {
            title: broadcast.title,
            message: broadcast.message,
            audience: broadcast.audience,
            deepLink: broadcast.deepLink,
            status: broadcast.status,
            updatedBy: broadcast.updatedBy,
            ...(broadcast.scheduledAt ? { scheduledAt: broadcast.scheduledAt } : {}),
          },
          ...(broadcast.scheduledAt ? {} : { $unset: { scheduledAt: 1 } }),
        },
        { returnDocument: "after" },
      )
      .exec();
    if (!saved) throw apiConflict("This broadcast is already being sent", "BROADCAST_NOT_EDITABLE");
    return saved;
  }

  async cancel(id: string, adminUserId: string): Promise<BroadcastDocument> {
    const cancelled = await this.broadcastModel
      .findOneAndUpdate(
        { _id: id, status: { $in: EDITABLE } },
        { $set: { status: BroadcastStatus.CANCELLED, updatedBy: new Types.ObjectId(adminUserId) } },
        { returnDocument: "after" },
      )
      .exec();
    if (cancelled) return cancelled;
    await this.get(id);
    throw apiConflict("Only drafts and scheduled broadcasts can be cancelled", "BROADCAST_NOT_EDITABLE");
  }

  // ── Sending ───────────────────────────────────────────────────────────

  /** How many accounts a broadcast to this audience would reach right now. */
  async audienceSize(audience: BroadcastAudience): Promise<number> {
    if (audience === BroadcastAudience.APPROVED_DRIVERS) {
      const approved = await this.driverModel.find({ driverStatus: DriverStatus.APPROVED }).select("userId").lean().exec();
      return this.userModel
        .countDocuments({ _id: { $in: approved.map((driver) => driver.userId) }, status: { $ne: UserStatus.BLOCKED } })
        .exec();
    }
    return this.userModel.countDocuments(this.userFilter(audience)).exec();
  }

  /**
   * Starts sending now (drafts and scheduled alike). Returns immediately
   * with status SENDING; delivery continues in the background and is
   * resumable if the process stops mid-way.
   */
  async sendNow(id: string, adminUserId: string): Promise<BroadcastDocument> {
    const claimed = await this.broadcastModel
      .findOneAndUpdate(
        { _id: id, status: { $in: EDITABLE } },
        {
          $set: {
            status: BroadcastStatus.SENDING,
            startedAt: new Date(),
            leaseUntil: new Date(Date.now() + LEASE_MS),
            sentBy: new Types.ObjectId(adminUserId),
          },
        },
        { returnDocument: "after" },
      )
      .exec();
    if (!claimed) {
      const existing = await this.get(id);
      throw apiConflict(`This broadcast is already ${existing.status.toLowerCase()}`, "BROADCAST_NOT_EDITABLE");
    }
    this.track(this.deliver(claimed));
    return claimed;
  }

  /** Worker tick: due scheduled broadcasts, and sends whose sender died. */
  async runDue(): Promise<void> {
    const now = new Date();
    for (let picked = 0; picked < 10; picked += 1) {
      const claimed = await this.broadcastModel
        .findOneAndUpdate(
          {
            $or: [
              { status: BroadcastStatus.SCHEDULED, scheduledAt: { $lte: now } },
              { status: BroadcastStatus.SENDING, leaseUntil: { $lte: now } },
            ],
          },
          [
            {
              $set: {
                status: BroadcastStatus.SENDING,
                startedAt: { $ifNull: ["$startedAt", now] },
                leaseUntil: new Date(now.getTime() + LEASE_MS),
              },
            },
          ],
          { returnDocument: "after", sort: { scheduledAt: 1 }, updatePipeline: true },
        )
        .exec();
      if (!claimed) return;
      this.track(this.deliver(claimed));
    }
  }

  /** Resolves once every send started by this instance has finished (tests, shutdown). */
  async drain(): Promise<void> {
    while (this.running.size) await Promise.all([...this.running]);
    await this.notifications.drain();
  }

  private track(run: Promise<void>): void {
    this.running.add(run);
    void run.finally(() => this.running.delete(run));
  }

  private async deliver(broadcast: BroadcastDocument): Promise<void> {
    let cursor = broadcast.lastUserId;
    let processed = broadcast.processedCount;
    try {
      for (;;) {
        const batch = await this.nextRecipients(broadcast.audience, cursor);
        if (!batch.length) break;

        await this.notifications.notify(
          batch.map(
            (recipient): NotificationDraft => ({
              userId: recipient.userId.toString(),
              recipientRole: recipient.role,
              type: NotificationType.ANNOUNCEMENT,
              title: broadcast.title,
              message: broadcast.message,
              referenceId: broadcast._id.toString(),
              data: { broadcastId: broadcast._id.toString(), deepLink: broadcast.deepLink },
              // One per user per broadcast, even if a resumed send overlaps.
              dedupeKey: `broadcast:${broadcast._id.toString()}:${recipient.userId.toString()}`,
            }),
          ),
        );
        // Pace FCM: let this batch's pushes finish before the next.
        await this.notifications.drain();

        cursor = batch[batch.length - 1].userId;
        processed += batch.length;
        await this.broadcastModel
          .updateOne(
            { _id: broadcast._id, status: BroadcastStatus.SENDING },
            { $set: { lastUserId: cursor, processedCount: processed, leaseUntil: new Date(Date.now() + LEASE_MS) } },
          )
          .exec();
      }
      await this.broadcastModel
        .updateOne(
          { _id: broadcast._id, status: BroadcastStatus.SENDING },
          { $set: { status: BroadcastStatus.SENT, sentAt: new Date(), processedCount: processed }, $unset: { leaseUntil: 1 } },
        )
        .exec();
      this.logger.log(`Broadcast ${broadcast._id.toString()} sent to ${processed} users (${broadcast.audience})`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Broadcast ${broadcast._id.toString()} failed after ${processed} users: ${message}`);
      await this.broadcastModel
        .updateOne(
          { _id: broadcast._id, status: BroadcastStatus.SENDING },
          { $set: { status: BroadcastStatus.FAILED, error: message.slice(0, 300), processedCount: processed } },
        )
        .exec();
    }
  }

  private async nextRecipients(audience: BroadcastAudience, after?: Types.ObjectId): Promise<Recipient[]> {
    const afterFilter = after ? { $gt: after } : { $exists: true };
    if (audience === BroadcastAudience.APPROVED_DRIVERS) {
      // Approved profiles in userId order; blocked accounts are skipped.
      const drivers = await this.driverModel
        .find({ driverStatus: DriverStatus.APPROVED, userId: afterFilter })
        .sort({ userId: 1 })
        .limit(this.batchSize)
        .select("userId")
        .lean()
        .exec();
      if (!drivers.length) return [];
      const active = await this.userModel
        .find({ _id: { $in: drivers.map((driver) => driver.userId) }, status: { $ne: UserStatus.BLOCKED } })
        .select("_id")
        .lean()
        .exec();
      const allowed = new Set(active.map((user) => user._id.toString()));
      const recipients = drivers
        .filter((driver) => allowed.has(driver.userId.toString()))
        .map((driver) => ({ userId: driver.userId, role: UserRole.DRIVER }));
      // Keep the cursor moving even when a whole batch is blocked accounts.
      if (!recipients.length) return this.nextRecipients(audience, drivers[drivers.length - 1].userId);
      return recipients;
    }
    const users = await this.userModel
      .find({ ...this.userFilter(audience), _id: afterFilter })
      .sort({ _id: 1 })
      .limit(this.batchSize)
      .select("_id role")
      .lean()
      .exec();
    return users.map((user) => ({ userId: user._id, role: user.role }));
  }

  private userFilter(audience: BroadcastAudience): QueryFilter<User> {
    const roles =
      audience === BroadcastAudience.ALL_CUSTOMERS
        ? [UserRole.CUSTOMER]
        : audience === BroadcastAudience.ALL_DRIVERS
          ? [UserRole.DRIVER]
          : [UserRole.CUSTOMER, UserRole.DRIVER];
    return { role: { $in: roles }, status: { $ne: UserStatus.BLOCKED } };
  }

  private assertFuture(date: Date): void {
    if (date.getTime() < Date.now() + 60_000)
      throw apiBadRequest("Schedule the broadcast at least a minute in the future", "BROADCAST_INVALID_SCHEDULE");
  }
}
