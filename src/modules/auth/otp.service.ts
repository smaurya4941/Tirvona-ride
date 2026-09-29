import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import type { OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectModel } from "@nestjs/mongoose";
import type { Model } from "mongoose";
import { ApiException, apiBadRequest } from "../../common/exceptions/api.exception";
import { maskPhone } from "../../common/phone/phone-number";
import { WhatsAppDeliveryError, WhatsAppGateway } from "../whatsapp/whatsapp.gateway";
import { OtpSendQuota } from "./schemas/otp-send-quota.schema";
import { OtpPurpose, OtpVerification } from "./schemas/otp-verification.schema";

export const OTP_LENGTH = 6;

/** What the client needs to drive the OTP screen. Never contains the code. */
export interface OtpChallenge {
  channel: "WHATSAPP";
  codeLength: number;
  expiresAt: Date;
  /** Seconds until the server accepts a resend (the UI countdown). */
  resendAvailableInSeconds: number;
  /** Codes this number may still be sent in the current window. */
  sendsRemaining: number;
  /** False when an earlier, still-valid code was kept (inside the cooldown). */
  codeSent: boolean;
}

interface QuotaReservation {
  sentAt: Date;
  previousLastSentAt?: Date;
  sendsRemaining: number;
}

const isDuplicateKey = (error: unknown): boolean => (error as { code?: number } | undefined)?.code === 11000;

const secondsUntil = (date: Date, now: number): number => Math.max(0, Math.ceil((date.getTime() - now) / 1000));

/**
 * Signup (and legacy phone) verification codes: generation, per-number
 * send limits, WhatsApp delivery and verification. NestJS is the only
 * authority — the app never sees, generates or checks a code.
 *
 *  - Stored as HMAC-SHA256(OTP_HASH_SECRET, purpose:phone:code). A bare
 *    hash of a 6-digit code is reversible from a DB dump in milliseconds;
 *    binding phone and purpose means a code can only ever verify the
 *    number and flow it was issued for.
 *  - One active code per (phone, purpose): a resend overwrites the hash,
 *    so every earlier code dies. Success deletes the record immediately;
 *    the TTL index only cleans up codes nobody used.
 *  - Attempts are counted atomically *before* the comparison, so parallel
 *    guesses cannot exceed OTP_MAX_ATTEMPTS.
 *  - The code is never logged (the dev-only log gateway aside).
 */
@Injectable()
export class OtpService implements OnModuleInit {
  private readonly logger = new Logger(OtpService.name);
  private readonly ttlMs: number;
  private readonly maxAttempts: number;
  private readonly cooldownMs: number;
  private readonly maxSendsPerWindow: number;
  private readonly windowMs: number;
  private readonly hashSecret: string;

  constructor(
    @InjectModel(OtpVerification.name) private readonly otpModel: Model<OtpVerification>,
    @InjectModel(OtpSendQuota.name) private readonly quotaModel: Model<OtpSendQuota>,
    private readonly whatsapp: WhatsAppGateway,
    config: ConfigService,
  ) {
    this.ttlMs = config.getOrThrow<number>("otpTtlSeconds") * 1000;
    this.maxAttempts = config.getOrThrow<number>("otpMaxAttempts");
    this.cooldownMs = config.getOrThrow<number>("otpResendCooldownSeconds") * 1000;
    this.maxSendsPerWindow = config.getOrThrow<number>("otpMaxSendsPerWindow");
    this.windowMs = config.getOrThrow<number>("otpSendWindowMinutes") * 60_000;
    this.hashSecret = config.getOrThrow<string>("otpHashSecret");
  }

  /**
   * Before signup OTP, otp_verifications kept one document per send. Drop
   * what is left of those (expired or used) so the unique (phone, purpose)
   * index can build on an existing database.
   */
  async onModuleInit(): Promise<void> {
    try {
      await this.otpModel.deleteMany({ $or: [{ expiresAt: { $lte: new Date() } }, { verified: true }] }).exec();
      await this.otpModel.createIndexes();
    } catch (error) {
      this.logger.warn(`Could not prepare otp_verifications indexes: ${(error as Error).message}`);
    }
  }

  /**
   * Issues a fresh code and delivers it over WhatsApp. Resolves only when
   * Meta has accepted the message — on failure the new code is withdrawn,
   * the send is not counted against the number, and the caller gets a
   * generic error (Meta's details stay in the log).
   */
  async issue(phone: string, purpose: OtpPurpose): Promise<OtpChallenge> {
    const reservation = await this.reserveSend(phone, purpose);
    const code = randomInt(0, 10 ** OTP_LENGTH).toString().padStart(OTP_LENGTH, "0");
    const otpHash = this.hash(phone, purpose, code);
    const expiresAt = new Date(reservation.sentAt.getTime() + this.ttlMs);

    // Overwrites any earlier code for this number and purpose.
    let record: { _id: unknown };
    try {
      record = await this.writeCode(phone, purpose, otpHash, expiresAt, reservation.sentAt);
    } catch (error) {
      await this.releaseSend(phone, purpose, reservation);
      throw error;
    }

    try {
      await this.whatsapp.sendAuthenticationCode({ to: phone, code });
    } catch (error) {
      await this.otpModel.deleteOne({ _id: record._id, otpHash }).exec();
      await this.releaseSend(phone, purpose, reservation);
      throw this.deliveryError(error, phone, purpose);
    }

    this.logger.log(`OTP issued for ${maskPhone(phone)} (${purpose}) via ${this.whatsapp.provider}`);
    return {
      channel: "WHATSAPP",
      codeLength: OTP_LENGTH,
      expiresAt,
      resendAvailableInSeconds: Math.ceil(this.cooldownMs / 1000),
      sendsRemaining: reservation.sendsRemaining,
      codeSent: true,
    };
  }

  /**
   * The code currently waiting for this number, if one is still usable —
   * lets a re-submitted form reuse it inside the cooldown instead of failing.
   */
  async activeChallenge(phone: string, purpose: OtpPurpose): Promise<OtpChallenge | null> {
    const now = Date.now();
    const [record, quota] = await Promise.all([
      this.otpModel.findOne({ phone, purpose }).lean().exec(),
      this.quotaModel.findOne({ phone, purpose }).lean().exec(),
    ]);
    if (!record || record.verified || record.expiresAt.getTime() <= now || record.attempts >= this.maxAttempts)
      return null;
    const windowOpen = quota && quota.expiresAt.getTime() > now;
    const resendAt = new Date((quota?.lastSentAt?.getTime() ?? 0) + this.cooldownMs);
    return {
      channel: "WHATSAPP",
      codeLength: OTP_LENGTH,
      expiresAt: record.expiresAt,
      resendAvailableInSeconds: secondsUntil(resendAt, now),
      sendsRemaining: windowOpen ? Math.max(0, this.maxSendsPerWindow - quota.sendCount) : this.maxSendsPerWindow,
      codeSent: false,
    };
  }

  /** Checks a code and, when it matches, consumes it (single use). */
  async verify(phone: string, purpose: OtpPurpose, code: string): Promise<void> {
    const notActive = apiBadRequest(
      "This code is no longer active. Request a new one.",
      "OTP_NOT_ACTIVE",
    );
    const tooMany = apiBadRequest(
      "Too many incorrect attempts. Request a new code.",
      "OTP_TOO_MANY_ATTEMPTS",
    );

    const record = await this.otpModel.findOne({ phone, purpose }).exec();
    if (!record || record.verified) throw notActive;
    if (record.expiresAt.getTime() <= Date.now())
      throw apiBadRequest("This code has expired. Request a new one.", "OTP_EXPIRED");
    if (record.attempts >= this.maxAttempts) throw tooMany;

    // Count the attempt first, conditional on this exact code still being
    // the active one — a resend or a parallel guess in between loses.
    const counted = await this.otpModel
      .findOneAndUpdate(
        { _id: record._id, otpHash: record.otpHash, verified: false, attempts: { $lt: this.maxAttempts } },
        { $inc: { attempts: 1 } },
        { returnDocument: "after" },
      )
      .exec();
    if (!counted) {
      const latest = await this.otpModel.findById(record._id).lean().exec();
      throw latest && latest.otpHash === record.otpHash && latest.attempts >= this.maxAttempts ? tooMany : notActive;
    }

    if (!this.matches(record.otpHash, phone, purpose, code)) {
      const attemptsRemaining = Math.max(0, this.maxAttempts - counted.attempts);
      this.logger.warn(`Incorrect OTP for ${maskPhone(phone)} (${purpose}), ${attemptsRemaining} attempts left`);
      if (attemptsRemaining === 0) throw tooMany;
      throw apiBadRequest("Incorrect verification code", "OTP_INVALID", { attemptsRemaining });
    }

    // Claim, then delete: exactly one request can win a correct code.
    const claimed = await this.otpModel
      .updateOne({ _id: record._id, otpHash: record.otpHash, verified: false }, { $set: { verified: true } })
      .exec();
    if (claimed.modifiedCount !== 1) throw notActive;
    await this.otpModel.deleteOne({ _id: record._id }).exec();
  }

  /** Withdraws any active code (e.g. the number turned out to be taken). */
  async discard(phone: string, purpose: OtpPurpose): Promise<void> {
    await this.otpModel.deleteOne({ phone, purpose }).exec();
  }

  // ── internals ────────────────────────────────────────────────────────

  private hash(phone: string, purpose: OtpPurpose, code: string): string {
    return createHmac("sha256", this.hashSecret).update(`${purpose}:${phone}:${code}`).digest("hex");
  }

  private matches(storedHash: string, phone: string, purpose: OtpPurpose, code: string): boolean {
    const expected = Buffer.from(storedHash, "hex");
    const actual = Buffer.from(this.hash(phone, purpose, code), "hex");
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  private async writeCode(
    phone: string,
    purpose: OtpPurpose,
    otpHash: string,
    expiresAt: Date,
    createdAt: Date,
  ): Promise<{ _id: unknown }> {
    const write = () =>
      this.otpModel
        .findOneAndUpdate(
          { phone, purpose },
          { $set: { otpHash, expiresAt, createdAt, attempts: 0, verified: false } },
          { upsert: true, returnDocument: "after" },
        )
        .lean()
        .exec();
    try {
      return (await write())!;
    } catch (error) {
      // Two first-time upserts raced on the unique index: the second one
      // simply updates the document the first created.
      if (!isDuplicateKey(error)) throw error;
      return (await write())!;
    }
  }

  /**
   * Atomically takes one send from the number's budget, enforcing the
   * resend cooldown and the per-window cap. Conditional updates make two
   * simultaneous requests for one number unable to both pass.
   */
  private async reserveSend(phone: string, purpose: OtpPurpose): Promise<QuotaReservation> {
    const now = new Date();
    const quota = await this.quotaModel.findOne({ phone, purpose }).lean().exec();

    if (quota && quota.expiresAt.getTime() > now.getTime()) {
      const resendAt = new Date((quota.lastSentAt?.getTime() ?? 0) + this.cooldownMs);
      if (resendAt.getTime() > now.getTime()) throw this.tooSoon(secondsUntil(resendAt, now.getTime()));
      if (quota.sendCount >= this.maxSendsPerWindow) throw this.limitReached(secondsUntil(quota.expiresAt, now.getTime()));

      const taken = await this.quotaModel
        .updateOne(
          {
            _id: quota._id,
            expiresAt: quota.expiresAt,
            sendCount: quota.sendCount,
            ...(quota.lastSentAt ? { lastSentAt: quota.lastSentAt } : {}),
          },
          { $inc: { sendCount: 1 }, $set: { lastSentAt: now } },
        )
        .exec();
      if (taken.modifiedCount !== 1) throw this.tooSoon(Math.ceil(this.cooldownMs / 1000));
      return {
        sentAt: now,
        previousLastSentAt: quota.lastSentAt,
        sendsRemaining: this.maxSendsPerWindow - quota.sendCount - 1,
      };
    }

    // No window yet, or the last one ended: open a new one.
    const window = {
      sendCount: 1,
      windowStartedAt: now,
      expiresAt: new Date(now.getTime() + this.windowMs),
      lastSentAt: now,
    };
    try {
      if (quota) {
        const reset = await this.quotaModel
          .updateOne({ _id: quota._id, expiresAt: quota.expiresAt }, { $set: window })
          .exec();
        if (reset.modifiedCount !== 1) throw this.tooSoon(Math.ceil(this.cooldownMs / 1000));
      } else {
        await this.quotaModel.create({ phone, purpose, ...window });
      }
    } catch (error) {
      if (isDuplicateKey(error)) throw this.tooSoon(Math.ceil(this.cooldownMs / 1000));
      throw error;
    }
    return { sentAt: now, previousLastSentAt: quota?.lastSentAt, sendsRemaining: this.maxSendsPerWindow - 1 };
  }

  /** A send that never reached WhatsApp does not count against the number. */
  private async releaseSend(phone: string, purpose: OtpPurpose, reservation: QuotaReservation): Promise<void> {
    try {
      await this.quotaModel
        .updateOne(
          { phone, purpose, lastSentAt: reservation.sentAt, sendCount: { $gt: 0 } },
          reservation.previousLastSentAt
            ? { $inc: { sendCount: -1 }, $set: { lastSentAt: reservation.previousLastSentAt } }
            : { $inc: { sendCount: -1 }, $unset: { lastSentAt: 1 } },
        )
        .exec();
    } catch (error) {
      this.logger.warn(`Could not release OTP send quota for ${maskPhone(phone)}: ${(error as Error).message}`);
    }
  }

  private deliveryError(error: unknown, phone: string, purpose: OtpPurpose): ApiException {
    if (!(error instanceof WhatsAppDeliveryError)) {
      this.logger.error(`OTP delivery crashed for ${maskPhone(phone)} (${purpose}): ${(error as Error)?.message}`);
      return new ApiException(
        HttpStatus.SERVICE_UNAVAILABLE,
        "We couldn't send the verification code. Please try again in a moment.",
        "OTP_DELIVERY_FAILED",
      );
    }
    if (error.reason === "RECIPIENT_UNAVAILABLE")
      return new ApiException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        "We couldn't reach this number on WhatsApp. Check that WhatsApp is active on it.",
        "WHATSAPP_RECIPIENT_UNAVAILABLE",
      );
    return new ApiException(
      HttpStatus.SERVICE_UNAVAILABLE,
      "We couldn't send the verification code. Please try again in a moment.",
      "OTP_DELIVERY_FAILED",
    );
  }

  private tooSoon(retryAfterSeconds: number): ApiException {
    return new ApiException(
      HttpStatus.TOO_MANY_REQUESTS,
      `Please wait ${retryAfterSeconds}s before requesting another code.`,
      "OTP_RESEND_TOO_SOON",
      { retryAfterSeconds },
    );
  }

  private limitReached(retryAfterSeconds: number): ApiException {
    const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
    return new ApiException(
      HttpStatus.TOO_MANY_REQUESTS,
      `Too many codes requested for this number. Try again in ${minutes} min.`,
      "OTP_SEND_LIMIT_REACHED",
      { retryAfterSeconds },
    );
  }
}
