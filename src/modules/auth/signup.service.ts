import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectModel } from "@nestjs/mongoose";
import type { Model } from "mongoose";
import { apiBadRequest, apiConflict } from "../../common/exceptions/api.exception";
import { maskPhone } from "../../common/phone/phone-number";
import { UserRole } from "../../common/types/user-role.enum";
import { DriversService } from "../drivers/drivers.service";
import type { UserDocument } from "../users/schemas/user.schema";
import { UsersService } from "../users/users.service";
import type { AuthSession, AuthUserView } from "./auth.service";
import { AuthService } from "./auth.service";
import type { RegisterDto } from "./dto/register.dto";
import type { ResendOtpDto } from "./dto/resend-otp.dto";
import type { VerifyOtpDto } from "./dto/verify-otp.dto";
import type { OtpChallenge } from "./otp.service";
import { OtpService } from "./otp.service";
import { PendingSignup } from "./schemas/pending-signup.schema";
import type { PendingSignupDocument } from "./schemas/pending-signup.schema";
import { OtpPurpose } from "./schemas/otp-verification.schema";
import type { DeviceMetadata } from "./token.service";

/** Returned by register and resend: everything the OTP screen shows. */
export interface OtpChallengeView {
  phone: string;
  maskedPhone: string;
  channel: "WHATSAPP";
  codeLength: number;
  expiresAt: Date;
  expiresInSeconds: number;
  resendAvailableInSeconds: number;
  sendsRemaining: number;
  codeSent: boolean;
}

export interface SignupChallengeView extends OtpChallengeView {
  /** Opaque handle for this sign-up; required by verify-otp and resend-otp. */
  verificationId: string;
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

const sameHash = (a: string, b: string): boolean => {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
};

const duplicateField = (error: unknown): string | null => {
  const duplicate = error as { code?: number; keyPattern?: Record<string, unknown>; keyValue?: Record<string, unknown> };
  if (duplicate?.code !== 11000) return null;
  return Object.keys(duplicate.keyPattern ?? duplicate.keyValue ?? {})[0] ?? "";
};

/**
 * Signup with WhatsApp phone verification:
 *
 *   register ─► pending_signups + WhatsApp code ─► verify-otp ─► user + session
 *
 * No user exists until the code is verified, and a user is created with
 * isPhoneVerified=true — no request can mark a phone verified any other way.
 * AuthService decides nothing about delivery; OtpService/WhatsAppGateway do.
 */
@Injectable()
export class SignupService {
  private readonly logger = new Logger(SignupService.name);
  private readonly pendingTtlMs: number;

  constructor(
    @InjectModel(PendingSignup.name) private readonly pendingModel: Model<PendingSignup>,
    private readonly users: UsersService,
    private readonly drivers: DriversService,
    private readonly otp: OtpService,
    private readonly auth: AuthService,
    config: ConfigService,
  ) {
    this.pendingTtlMs = config.getOrThrow<number>("signupPendingTtlMinutes") * 60_000;
  }

  /** POST /auth/register — validates, stores the pending form and sends the code. */
  async register(dto: RegisterDto, ipAddress?: string): Promise<SignupChallengeView> {
    const phone = dto.phone;
    await this.assertAvailable(phone, dto.email);

    // Every submission gets a fresh id: an earlier (or someone else's)
    // pending form for this number stops being verifiable.
    const verificationId = randomBytes(32).toString("base64url");
    const pending = await this.savePending({
      phone,
      verificationIdHash: sha256(verificationId),
      firstName: dto.firstName,
      lastName: dto.lastName,
      email: dto.email,
      passwordHash: await this.users.hashPassword(dto.password),
      role: dto.role,
      ipAddress,
      expiresAt: new Date(Date.now() + this.pendingTtlMs),
    });

    // Re-submitting the form inside the resend cooldown keeps the code
    // already on its way instead of failing or sending a second one.
    const active = await this.otp.activeChallenge(phone, OtpPurpose.SIGNUP);
    let challenge: OtpChallenge;
    if (active && active.resendAvailableInSeconds > 0) {
      challenge = active;
    } else {
      try {
        challenge = await this.otp.issue(phone, OtpPurpose.SIGNUP);
      } catch (error) {
        // The client never received this verificationId: nothing can use it.
        await this.pendingModel.deleteOne({ _id: pending._id, verificationIdHash: pending.verificationIdHash }).exec();
        throw error;
      }
    }

    this.logger.log(`Signup started for ${maskPhone(phone)} as ${dto.role}`);
    return { verificationId, ...this.view(phone, challenge) };
  }

  /** POST /auth/resend-otp — a new code; every earlier one stops working. */
  async resend(dto: ResendOtpDto): Promise<SignupChallengeView> {
    const pending = await this.pendingFor(dto.phone, dto.verificationId);
    if (await this.users.existsByPhone(dto.phone)) {
      await this.abandon(pending);
      throw this.phoneTaken();
    }
    const challenge = await this.otp.issue(dto.phone, OtpPurpose.SIGNUP);
    // The sign-up stays open while the user is actively retrying.
    await this.pendingModel
      .updateOne({ _id: pending._id }, { $set: { expiresAt: new Date(Date.now() + this.pendingTtlMs) } })
      .exec();
    return { verificationId: dto.verificationId, ...this.view(dto.phone, challenge) };
  }

  /**
   * POST /auth/verify-otp — checks the code, creates the (phone-verified)
   * account, and signs the user in. The pending form and the code are both
   * gone afterwards, so neither can be replayed.
   */
  async verify(dto: VerifyOtpDto, device: DeviceMetadata): Promise<AuthSession> {
    const pending = await this.pendingFor(dto.phone, dto.verificationId);
    // Someone finished signing up with this number (or email) meanwhile:
    // fail before spending the code.
    if (await this.users.existsByPhone(pending.phone)) {
      await this.abandon(pending);
      throw this.phoneTaken();
    }
    if (pending.email && (await this.users.existsByEmail(pending.email))) throw this.emailTaken();

    await this.otp.verify(pending.phone, OtpPurpose.SIGNUP, dto.otp);

    const user = await this.createAccount(pending);
    await this.pendingModel.deleteOne({ _id: pending._id }).exec();
    this.logger.log(`Signup completed for ${maskPhone(pending.phone)} as ${user.role}`);
    return this.auth.startSession(user._id.toString(), user.role, device);
  }

  // ── Accounts created before signup OTP ───────────────────────────────

  /**
   * POST /auth/phone/send-otp — for a signed-in account whose number was
   * never verified (created before WhatsApp signup existed). The code goes
   * to the account's own number; the request cannot name another one.
   */
  async sendExistingAccountCode(userId: string): Promise<OtpChallengeView> {
    const user = await this.users.findById(userId);
    if (user.isPhoneVerified)
      throw apiConflict("Your mobile number is already verified.", "PHONE_ALREADY_VERIFIED");
    const active = await this.otp.activeChallenge(user.phone, OtpPurpose.PHONE_VERIFICATION);
    const challenge =
      active && active.resendAvailableInSeconds > 0
        ? active
        : await this.otp.issue(user.phone, OtpPurpose.PHONE_VERIFICATION);
    return this.view(user.phone, challenge);
  }

  /** POST /auth/phone/verify-otp — marks the signed-in account's number verified. */
  async verifyExistingAccount(userId: string, code: string): Promise<AuthUserView> {
    const user = await this.users.findById(userId);
    if (!user.isPhoneVerified) {
      await this.otp.verify(user.phone, OtpPurpose.PHONE_VERIFICATION, code);
      await this.users.markPhoneVerified(userId);
    }
    return this.auth.buildUserView(userId);
  }

  // ── internals ────────────────────────────────────────────────────────

  private async assertAvailable(phone: string, email?: string): Promise<void> {
    if (await this.users.existsByPhone(phone)) throw this.phoneTaken();
    if (email && (await this.users.existsByEmail(email))) throw this.emailTaken();
  }

  private async pendingFor(phone: string, verificationId: string): Promise<PendingSignupDocument> {
    const pending = await this.pendingModel.findOne({ phone }).exec();
    if (
      !pending ||
      pending.expiresAt.getTime() <= Date.now() ||
      !sameHash(pending.verificationIdHash, sha256(verificationId))
    )
      throw apiBadRequest(
        "This sign-up has expired or was replaced. Please sign up again.",
        "SIGNUP_SESSION_INVALID",
      );
    return pending;
  }

  private async savePending(fields: PendingSignup): Promise<PendingSignupDocument> {
    const write = () =>
      this.pendingModel
        .findOneAndReplace({ phone: fields.phone }, fields, { upsert: true, returnDocument: "after", runValidators: true })
        .exec();
    try {
      return (await write())!;
    } catch (error) {
      // Two first submissions for one number raced on the unique index.
      if (duplicateField(error) === null) throw error;
      return (await write())!;
    }
  }

  private async createAccount(pending: PendingSignupDocument): Promise<UserDocument> {
    let user: UserDocument;
    try {
      user = await this.users.createVerified({
        phone: pending.phone,
        email: pending.email,
        passwordHash: pending.passwordHash,
        role: pending.role,
        firstName: pending.firstName,
        lastName: pending.lastName,
      });
    } catch (error) {
      const field = duplicateField(error);
      if (field === "email") throw this.emailTaken();
      if (field !== null) throw this.phoneTaken();
      throw error;
    }

    if (user.role === UserRole.DRIVER) {
      try {
        await this.drivers.createProfileForUser(user._id.toString());
      } catch (error) {
        // No half-made driver accounts: undo, the user can sign up again.
        await this.users.deleteById(user._id.toString());
        throw error;
      }
    }
    return user;
  }

  private async abandon(pending: PendingSignupDocument): Promise<void> {
    await Promise.all([
      this.pendingModel.deleteOne({ _id: pending._id }).exec(),
      this.otp.discard(pending.phone, OtpPurpose.SIGNUP),
    ]);
  }

  private view(phone: string, challenge: OtpChallenge): OtpChallengeView {
    return {
      phone,
      maskedPhone: maskPhone(phone),
      channel: challenge.channel,
      codeLength: challenge.codeLength,
      expiresAt: challenge.expiresAt,
      expiresInSeconds: Math.max(0, Math.round((challenge.expiresAt.getTime() - Date.now()) / 1000)),
      resendAvailableInSeconds: challenge.resendAvailableInSeconds,
      sendsRemaining: challenge.sendsRemaining,
      codeSent: challenge.codeSent,
    };
  }

  private phoneTaken() {
    return apiConflict(
      "This mobile number is already registered. Log in instead.",
      "PHONE_ALREADY_REGISTERED",
    );
  }

  private emailTaken() {
    return apiConflict(
      "This email is already used by another account.",
      "EMAIL_ALREADY_REGISTERED",
    );
  }
}
