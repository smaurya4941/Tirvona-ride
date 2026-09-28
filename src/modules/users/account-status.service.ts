import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import type { Model } from "mongoose";
import { isValidObjectId } from "mongoose";
import { User, UserStatus } from "./schemas/user.schema";

const CACHE_TTL_MS = 15_000;
const CACHE_MAX_ENTRIES = 10_000;

/**
 * "May this account still use its access token?" — checked by JwtAuthGuard
 * on every authenticated request so blocking a customer or driver takes
 * effect immediately instead of when the 15-minute access token expires.
 *
 * Answers are cached briefly per user (one small indexed read per user per
 * 15 s at most). A block on this instance invalidates its cache entry at
 * once; other instances converge within the TTL.
 */
@Injectable()
export class AccountStatusService {
  private readonly cache = new Map<string, { allowed: boolean; expiresAt: number }>();

  constructor(@InjectModel(User.name) private readonly userModel: Model<User>) {}

  async isAllowed(userId: string): Promise<boolean> {
    const now = Date.now();
    const cached = this.cache.get(userId);
    if (cached && cached.expiresAt > now) return cached.allowed;

    if (!isValidObjectId(userId)) return false;
    const user = await this.userModel.findById(userId).select("status").lean().exec();
    const allowed = Boolean(user) && user!.status !== UserStatus.BLOCKED;

    if (this.cache.size >= CACHE_MAX_ENTRIES) this.cache.clear();
    this.cache.set(userId, { allowed, expiresAt: now + CACHE_TTL_MS });
    return allowed;
  }

  invalidate(userId: string): void {
    this.cache.delete(userId);
  }
}
