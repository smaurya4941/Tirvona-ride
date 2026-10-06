import { createHash, randomBytes } from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectModel } from "@nestjs/mongoose";
import type { Model } from "mongoose";
import {
  apiBadRequest,
  apiNotFound,
} from "../../common/exceptions/api.exception";
import { maskPhone } from "../../common/phone/phone-number";
import { UserRole } from "../../common/types/user-role.enum";
import { DomainEventsService } from "../../infrastructure/events/domain-events.service";
import type { UserDocument } from "../users/schemas/user.schema";
import { UsersService } from "../users/users.service";
import type { AuthSession } from "./auth.service";
import { AuthService } from "./auth.service";
import { toOtpChallengeView } from "./otp-challenge.view";
import type { OtpChallengeView } from "./otp-challenge.view";
import { OtpService } from "./otp.service";
import { OtpPurpose } from "./schemas/otp-verification.schema";
import { PasswordReset } from "./schemas/password-reset.schema";
import type { DeviceMetadata } from "./token.service";
import { TokenService } from "./token.service";

export interface PasswordResetTicket {
  /** One-time token for POST /auth/password/reset. */
  resetToken: string;
  expiresAt: Date;
  expiresInSeconds: number;
}

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

/**
 * Forgot password over WhatsApp:
 *
 *   forgot ─► WhatsApp code ─► verify-otp ─► one-time reset token ─► reset ─► new session
 *
 * The code proves the person holds the account's phone; the token lets the
 * app ask for the new password on a separate step without keeping the code
 * alive. A reset ends every existing session (a thief who knew the old
 * password is signed out everywhere) and signs this device in.
 *
 * Whether a number has an account is not secret here: sign-up already
 * answers "this number is registered", so pretending otherwise would only
 * leave real users waiting for a code that never comes. Admin accounts are
 * never reset this way (they are seeded and managed out of band) and look
 * like unknown numbers.
 */
@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);
  private readonly tokenTtlMs: number;

  constructor(
    @InjectModel(PasswordReset.name)
    private readonly resetModel: Model<PasswordReset>,
    private readonly users: UsersService,
    private readonly otp: OtpService,
    private readonly auth: AuthService,
    private readonly tokens: TokenService,
    private readonly domainEvents: DomainEventsService,
    config: ConfigService,
  ) {
    this.tokenTtlMs =
      config.getOrThrow<number>("passwordResetTokenTtlMinutes") * 60_000;
  }

  /** POST /auth/password/forgot — sends (or keeps, inside the cooldown) a reset code. */
  async requestCode(phone: string): Promise<OtpChallengeView> {
    await this.resettableAccount(phone);
    // Tapping "Send code" twice keeps the code already on its way.
    const active = await this.otp.activeChallenge(
      phone,
      OtpPurpose.RESET_PASSWORD,
    );
    const challenge =
      active && active.resendAvailableInSeconds > 0
        ? active
        : await this.otp.issue(phone, OtpPurpose.RESET_PASSWORD);
    if (challenge.codeSent)
      this.logger.log(`Password reset code sent to ${maskPhone(phone)}`);
    return toOtpChallengeView(phone, challenge);
  }

  /** POST /auth/password/verify-otp — consumes the code and returns a one-time reset token. */
  async verifyCode(phone: string, code: string): Promise<PasswordResetTicket> {
    const user = await this.resettableAccount(phone);
    await this.otp.verify(phone, OtpPurpose.RESET_PASSWORD, code);

    const resetToken = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + this.tokenTtlMs);
    // One live token per account: a newer verification replaces the older one.
    await this.resetModel
      .findOneAndUpdate(
        { userId: user._id },
        { $set: { tokenHash: sha256(resetToken), expiresAt } },
        { upsert: true, returnDocument: "after" },
      )
      .exec();
    return {
      resetToken,
      expiresAt,
      expiresInSeconds: Math.round(this.tokenTtlMs / 1000),
    };
  }

  /**
   * POST /auth/password/reset — sets the new password, ends every other
   * session and signs this device in. The token is claimed atomically, so it
   * works exactly once even when two requests race.
   */
  async reset(
    resetToken: string,
    newPassword: string,
    device: DeviceMetadata,
  ): Promise<AuthSession> {
    const invalid = apiBadRequest(
      "This password reset link has expired. Request a new code.",
      "PASSWORD_RESET_INVALID",
    );
    const tokenHash = sha256(resetToken);
    const ticket = await this.resetModel.findOne({ tokenHash }).lean().exec();
    if (!ticket || ticket.expiresAt.getTime() <= Date.now()) throw invalid;

    const user = await this.users.findByIdWithPassword(
      ticket.userId.toString(),
    );
    if (!user || user.role === UserRole.ADMIN) throw invalid;
    this.auth.assertCanSignIn(user);
    // Checked before the token is spent, so the user can simply pick another.
    if (await this.users.verifyPassword(user, newPassword))
      throw apiBadRequest(
        "Choose a password you haven't used for this account.",
        "PASSWORD_UNCHANGED",
      );

    const claimed = await this.resetModel
      .findOneAndDelete({
        _id: ticket._id,
        tokenHash,
        expiresAt: { $gt: new Date() },
      })
      .exec();
    if (!claimed) throw invalid;

    const userId = user._id.toString();
    // Receiving the code on this number also proves the phone (legacy accounts).
    await this.users.setPassword(userId, newPassword, {
      markPhoneVerified: true,
    });
    const revoked = await this.tokens.revokeAllForUser(userId);
    this.domainEvents.emit("auth.sessions_revoked", {
      userId,
      reason: "PASSWORD_RESET",
      exceptDeviceId: device.deviceId,
    });
    this.logger.log(
      `Password reset for ${maskPhone(user.phone)}; ${revoked} session(s) ended`,
    );

    return this.auth.completeSignIn(user, device);
  }

  /** The account a reset may be started for; the same answer for unknown and admin numbers. */
  private async resettableAccount(phone: string): Promise<UserDocument> {
    const user = await this.users.findByPhone(phone);
    if (!user || user.role === UserRole.ADMIN)
      throw apiNotFound(
        "No Tirvona Rides account uses this mobile number. Check the number or create an account.",
        "ACCOUNT_NOT_FOUND",
      );
    this.auth.assertCanSignIn(user);
    return user;
  }
}
