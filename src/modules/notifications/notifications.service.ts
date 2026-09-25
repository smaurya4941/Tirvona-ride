import { Injectable, Logger } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import type { Model, QueryFilter } from "mongoose";
import { Types } from "mongoose";
import { apiNotFound } from "../../common/exceptions/api.exception";
import { UserRole } from "../../common/types/user-role.enum";
import { NotificationEvent } from "../realtime/realtime.constants";
import { RealtimeService } from "../realtime/realtime.service";
import type { Page } from "../rides/rides.service";
import { User, UserStatus } from "../users/schemas/user.schema";
import { DeviceTokensService } from "./device-tokens.service";
import type { NotificationDraft } from "./notification-plan";
import { PushStatus, isHighPriority, isRideStatusType } from "./notification-types";
import type { NotificationType } from "./notification-types";
import { PushGateway } from "./push/push.gateway";
import { Notification } from "./schemas/notification.schema";
import type { NotificationDocument } from "./schemas/notification.schema";

export interface NotificationView {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  rideId?: string;
  referenceId?: string;
  data: Record<string, string>;
  isRead: boolean;
  readAt?: Date;
  createdAt: Date;
}

export interface NotificationPage extends Page<NotificationView> {
  unreadCount: number;
}

const isDuplicateKey = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: number }).code === 11000;

/**
 * Creates in-app notifications and delivers them.
 *
 * Channel B (in-app) is the record: it is written first and is what the
 * notification centre and badge read. Channel A (FCM push) is attempted
 * afterwards, per device, and its outcome is stored on the record. A push
 * failure never loses the notification, and nothing here can fail the
 * ride/payment/safety action that produced it.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private readonly deliveries = new Set<Promise<void>>();

  constructor(
    @InjectModel(Notification.name) private readonly notificationModel: Model<Notification>,
    @InjectModel(User.name) private readonly userModel: Model<User>,
    private readonly deviceTokens: DeviceTokensService,
    private readonly push: PushGateway,
    private readonly realtime: RealtimeService,
  ) {}

  /** Records each draft (skipping replays) and starts its push delivery. */
  async notify(drafts: NotificationDraft[]): Promise<NotificationDocument[]> {
    const created: NotificationDocument[] = [];
    for (const draft of drafts) {
      try {
        created.push(
          await this.notificationModel.create({
            userId: new Types.ObjectId(draft.userId),
            recipientRole: draft.recipientRole,
            type: draft.type,
            title: draft.title,
            message: draft.message,
            rideId: draft.rideId ? new Types.ObjectId(draft.rideId) : undefined,
            referenceId: draft.referenceId,
            data: draft.data ?? {},
            dedupeKey: draft.dedupeKey,
            push: { status: PushStatus.PENDING },
          }),
        );
      } catch (error) {
        if (isDuplicateKey(error)) continue; // Already notified for this event.
        this.logger.error(
          `Could not record ${draft.type} notification for user ${draft.userId}`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }
    for (const notification of created) this.startDelivery(notification);
    return created;
  }

  /** Every active admin account (SOS, new complaints). */
  async notifyAdmins(draft: Omit<NotificationDraft, "userId" | "recipientRole">): Promise<NotificationDocument[]> {
    const admins = await this.userModel
      .find({ role: UserRole.ADMIN, status: UserStatus.ACTIVE })
      .select("_id")
      .lean()
      .exec();
    return this.notify(
      admins.map((admin) => ({
        ...draft,
        userId: admin._id.toString(),
        recipientRole: UserRole.ADMIN,
        dedupeKey: draft.dedupeKey ? `${draft.dedupeKey}:${admin._id.toString()}` : undefined,
      })),
    );
  }

  async list(
    userId: string,
    options: { page: number; limit: number; unreadOnly?: boolean },
  ): Promise<NotificationPage> {
    const owner = new Types.ObjectId(userId);
    const filter: QueryFilter<Notification> = { userId: owner };
    if (options.unreadOnly) filter.isRead = false;
    const [items, total, unreadCount] = await Promise.all([
      this.notificationModel
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((options.page - 1) * options.limit)
        .limit(options.limit)
        .exec(),
      this.notificationModel.countDocuments(filter).exec(),
      this.unreadCount(userId),
    ]);
    return {
      items: items.map((item) => this.toView(item)),
      page: options.page,
      limit: options.limit,
      total,
      hasMore: options.page * options.limit < total,
      unreadCount,
    };
  }

  async unreadCount(userId: string): Promise<number> {
    return this.notificationModel.countDocuments({ userId: new Types.ObjectId(userId), isRead: false }).exec();
  }

  /** Only the recipient can read (or learn of) a notification. Idempotent. */
  async markRead(userId: string, id: string): Promise<NotificationView> {
    const owner = new Types.ObjectId(userId);
    const notification =
      (await this.notificationModel
        .findOneAndUpdate(
          { _id: new Types.ObjectId(id), userId: owner, isRead: false },
          { $set: { isRead: true, readAt: new Date() } },
          { returnDocument: "after" },
        )
        .exec()) ?? (await this.notificationModel.findOne({ _id: new Types.ObjectId(id), userId: owner }).exec());
    if (!notification) throw apiNotFound("Notification not found", "NOTIFICATION_NOT_FOUND");
    this.publishUnreadCount(userId);
    return this.toView(notification);
  }

  async markAllRead(userId: string): Promise<{ updated: number }> {
    const result = await this.notificationModel
      .updateMany({ userId: new Types.ObjectId(userId), isRead: false }, { $set: { isRead: true, readAt: new Date() } })
      .exec();
    this.publishUnreadCount(userId);
    return { updated: result.modifiedCount };
  }

  /** Resolves when every push started so far has finished (tests, shutdown). */
  async drain(): Promise<void> {
    while (this.deliveries.size) await Promise.all([...this.deliveries]);
  }

  toView(notification: NotificationDocument): NotificationView {
    return {
      id: notification._id.toString(),
      type: notification.type,
      title: notification.title,
      message: notification.message,
      rideId: notification.rideId?.toString(),
      referenceId: notification.referenceId,
      data: notification.data ?? {},
      isRead: notification.isRead,
      readAt: notification.readAt,
      createdAt: notification.createdAt,
    };
  }

  private startDelivery(notification: NotificationDocument): void {
    const run = this.deliver(notification).catch((error: unknown) => {
      this.logger.error(
        `Delivery of notification ${notification._id.toString()} failed`,
        error instanceof Error ? error.stack : String(error),
      );
    });
    this.deliveries.add(run);
    void run.finally(() => this.deliveries.delete(run));
  }

  private async deliver(notification: NotificationDocument): Promise<void> {
    const userId = notification.userId.toString();

    // Open apps: update the notification centre and badge immediately.
    this.realtime.emitToUser(userId, NotificationEvent.CREATED, {
      notification: this.toView(notification),
      unreadCount: await this.unreadCount(userId),
    });

    if (!this.push.isConfigured) {
      await this.setPush(notification, { status: PushStatus.SKIPPED });
      return;
    }
    const tokens = await this.deviceTokens.activeTokens(notification.userId);
    if (!tokens.length) {
      await this.setPush(notification, { status: PushStatus.NO_DEVICES });
      return;
    }

    const results = await this.push.send(tokens, {
      title: notification.title,
      body: notification.message,
      data: {
        ...notification.data,
        notificationId: notification._id.toString(),
        type: notification.type,
        ...(notification.rideId ? { rideId: notification.rideId.toString() } : {}),
        ...(notification.referenceId ? { referenceId: notification.referenceId } : {}),
      },
      highPriority: isHighPriority(notification.type),
      collapseKey:
        notification.rideId && isRideStatusType(notification.type) ? `ride-${notification.rideId.toString()}` : undefined,
    });

    const delivered = results.filter((result) => result.delivered);
    const failed = results.filter((result) => !result.delivered);
    await Promise.all([
      this.deviceTokens.markInvalid(failed.filter((result) => result.tokenInvalid).map((result) => result.token)),
      this.deviceTokens.touch(delivered.map((result) => result.token)),
    ]);
    await this.setPush(notification, {
      status: !failed.length ? PushStatus.SENT : delivered.length ? PushStatus.PARTIAL : PushStatus.FAILED,
      sentCount: delivered.length,
      failedCount: failed.length,
      error: failed[0]?.error,
    });
    if (failed.length && !delivered.length)
      this.logger.warn(`Push ${notification.type} to user ${userId} failed on all devices: ${failed[0]?.error ?? ""}`);
  }

  private async setPush(
    notification: NotificationDocument,
    push: { status: PushStatus; sentCount?: number; failedCount?: number; error?: string },
  ): Promise<void> {
    await this.notificationModel
      .updateOne(
        { _id: notification._id },
        {
          $set: {
            "push.status": push.status,
            "push.sentCount": push.sentCount ?? 0,
            "push.failedCount": push.failedCount ?? 0,
            "push.attemptedAt": new Date(),
            ...(push.error ? { "push.error": push.error } : {}),
          },
        },
      )
      .exec();
  }

  private publishUnreadCount(userId: string): void {
    void this.unreadCount(userId)
      .then((unreadCount) => this.realtime.emitToUser(userId, NotificationEvent.UNREAD_COUNT, { unreadCount }))
      .catch(() => undefined);
  }
}
