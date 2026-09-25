import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectModel } from "@nestjs/mongoose";
import type { Model } from "mongoose";
import { Types } from "mongoose";
import { DeviceToken, DeviceTokenDeactivation } from "./schemas/device-token.schema";
import type { DevicePlatform, DeviceTokenDocument } from "./schemas/device-token.schema";

export interface RegisterDeviceTokenInput {
  token: string;
  platform: DevicePlatform;
  deviceId: string;
  appVersion?: string;
}

export interface DeviceTokenView {
  id: string;
  platform: DevicePlatform;
  deviceId: string;
  isActive: boolean;
  lastUsedAt: Date;
}

const isDuplicateKey = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: number }).code === 11000;

/**
 * FCM registration tokens. The caller is always the authenticated user —
 * the user id comes from the JWT, never from the request body — so nobody
 * can attach a token to someone else's account.
 *
 * - Register: upsert by token. A token already held by another account on
 *   the same phone (user switched accounts) moves to the new user.
 * - Refresh: registering a new token for the same device retires the old one.
 * - Logout: the device's tokens are deactivated (kept for the audit trail).
 * - Re-login: registering reactivates the same row.
 */
@Injectable()
export class DeviceTokensService {
  private readonly logger = new Logger(DeviceTokensService.name);
  private readonly maxPerUser: number;

  constructor(
    @InjectModel(DeviceToken.name) private readonly tokenModel: Model<DeviceToken>,
    config: ConfigService,
  ) {
    this.maxPerUser = config.getOrThrow<number>("deviceTokensMaxPerUser");
  }

  async register(userId: string, input: RegisterDeviceTokenInput): Promise<DeviceTokenView> {
    const owner = new Types.ObjectId(userId);
    const now = new Date();
    const previous = await this.tokenModel.findOne({ token: input.token }).select("userId").lean().exec();
    if (previous && !previous.userId.equals(owner))
      this.logger.log(`Device token moved to user ${userId} (account switch on device ${input.deviceId})`);

    let saved: DeviceTokenDocument | null;
    const upsert = () =>
      this.tokenModel
        .findOneAndUpdate(
          { token: input.token },
          {
            $set: {
              userId: owner,
              platform: input.platform,
              deviceId: input.deviceId,
              appVersion: input.appVersion,
              isActive: true,
              lastUsedAt: now,
            },
            $unset: { deactivatedAt: 1, deactivationReason: 1 },
          },
          { upsert: true, returnDocument: "after", runValidators: true },
        )
        .exec();
    try {
      saved = await upsert();
    } catch (error) {
      // Two concurrent first registrations of one token: the loser updates.
      if (!isDuplicateKey(error)) throw error;
      saved = await upsert();
    }
    if (!saved) throw new Error("Device token upsert returned nothing");

    // Token refresh: the device's previous token (for any account) is dead.
    await this.tokenModel
      .updateMany(
        { deviceId: input.deviceId, token: { $ne: input.token }, isActive: true },
        { $set: { isActive: false, deactivatedAt: now, deactivationReason: DeviceTokenDeactivation.REPLACED } },
      )
      .exec();
    await this.enforceLimit(owner);
    return this.toView(saved);
  }

  /** Explicit unregister from the app (sign out). Only the caller's own token. */
  async deactivate(userId: string, token: string): Promise<boolean> {
    const result = await this.tokenModel
      .updateOne(
        { token, userId: new Types.ObjectId(userId), isActive: true },
        { $set: { isActive: false, deactivatedAt: new Date(), deactivationReason: DeviceTokenDeactivation.LOGOUT } },
      )
      .exec();
    return result.modifiedCount > 0;
  }

  /** Server-side logout: every token the user's logged-out device holds. */
  async deactivateDevice(userId: string, deviceId: string): Promise<number> {
    const result = await this.tokenModel
      .updateMany(
        { userId: new Types.ObjectId(userId), deviceId, isActive: true },
        { $set: { isActive: false, deactivatedAt: new Date(), deactivationReason: DeviceTokenDeactivation.LOGOUT } },
      )
      .exec();
    return result.modifiedCount;
  }

  /** FCM said the token is gone (app uninstalled / data cleared). */
  async markInvalid(tokens: string[]): Promise<void> {
    if (!tokens.length) return;
    await this.tokenModel
      .updateMany(
        { token: { $in: tokens }, isActive: true },
        {
          $set: { isActive: false, deactivatedAt: new Date(), deactivationReason: DeviceTokenDeactivation.UNREGISTERED },
        },
      )
      .exec();
  }

  async touch(tokens: string[]): Promise<void> {
    if (!tokens.length) return;
    await this.tokenModel.updateMany({ token: { $in: tokens } }, { $set: { lastUsedAt: new Date() } }).exec();
  }

  async activeTokens(userId: string | Types.ObjectId): Promise<string[]> {
    const rows = await this.tokenModel
      .find({ userId: typeof userId === "string" ? new Types.ObjectId(userId) : userId, isActive: true })
      .select("token")
      .sort({ lastUsedAt: -1 })
      .limit(this.maxPerUser)
      .lean()
      .exec();
    return rows.map((row) => row.token);
  }

  async listForUser(userId: string): Promise<DeviceTokenView[]> {
    const rows = await this.tokenModel
      .find({ userId: new Types.ObjectId(userId) })
      .sort({ lastUsedAt: -1 })
      .limit(50)
      .exec();
    return rows.map((row) => this.toView(row));
  }

  private async enforceLimit(userId: Types.ObjectId): Promise<void> {
    const stale = await this.tokenModel
      .find({ userId, isActive: true })
      .sort({ lastUsedAt: -1 })
      .skip(this.maxPerUser)
      .select("_id")
      .lean()
      .exec();
    if (!stale.length) return;
    await this.tokenModel
      .updateMany(
        { _id: { $in: stale.map((row) => row._id) } },
        { $set: { isActive: false, deactivatedAt: new Date(), deactivationReason: DeviceTokenDeactivation.LIMIT } },
      )
      .exec();
  }

  private toView(token: DeviceTokenDocument): DeviceTokenView {
    return {
      id: token._id.toString(),
      platform: token.platform,
      deviceId: token.deviceId,
      isActive: token.isActive,
      lastUsedAt: token.lastUsedAt,
    };
  }
}
