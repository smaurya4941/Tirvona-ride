import { createHash, randomInt } from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import type { Model } from "mongoose";
import { apiBadRequest } from "../../common/exceptions/api.exception";
import { OtpPurpose, OtpVerification } from "./schemas/otp-verification.schema";

const OTP_TTL_MINUTES = 5;
const MAX_VERIFY_ATTEMPTS = 5;
const RESEND_COOLDOWN_SECONDS = 30;

// sha256 (not argon2) is deliberate: a 6-digit OTP has only 10^6 possibilities,
// so the hash algorithm's cost is irrelevant — the attempt counter below is
// what actually stops brute-forcing it.
const hashOtp = (otp: string): string =>
  createHash("sha256").update(otp).digest("hex");

@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);

  constructor(
    @InjectModel(OtpVerification.name)
    private readonly otpModel: Model<OtpVerification>,
  ) {}

  async send(phone: string, purpose: OtpPurpose): Promise<void> {
    const recent = await this.otpModel
      .findOne({ phone, purpose })
      .sort({ createdAt: -1 })
      .exec();
    if (
      recent &&
      Date.now() - recent.get("createdAt").getTime() <
        RESEND_COOLDOWN_SECONDS * 1000
    ) {
      throw apiBadRequest(
        "Please wait before requesting another code",
        "OTP_TOO_MANY_ATTEMPTS",
      );
    }

    const otp = randomInt(0, 1_000_000).toString().padStart(6, "0");
    await this.otpModel.create({
      phone,
      purpose,
      otpHash: hashOtp(otp),
      attempts: 0,
      verified: false,
      expiresAt: new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000),
    });

    // Local-dev stand-in for an SMS gateway — see spec §12.
    // Plain ASCII: the Windows console garbles "→".
    this.logger.log(`[DEV OTP] >>> ${otp} <<< for ${phone} (${purpose}), valid ${OTP_TTL_MINUTES} min`);
  }

  async verify(phone: string, purpose: OtpPurpose, otp: string): Promise<void> {
    const record = await this.otpModel
      .findOne({ phone, purpose, verified: false })
      .sort({ createdAt: -1 })
      .exec();
    if (!record)
      throw apiBadRequest("Request a new verification code", "OTP_INVALID");

    if (record.expiresAt.getTime() < Date.now())
      throw apiBadRequest(
        "This code has expired. Request a new one.",
        "OTP_EXPIRED",
      );

    if (record.attempts >= MAX_VERIFY_ATTEMPTS)
      throw apiBadRequest(
        "Too many attempts. Request a new code.",
        "OTP_TOO_MANY_ATTEMPTS",
      );

    if (record.otpHash !== hashOtp(otp)) {
      record.attempts += 1;
      await record.save();
      throw apiBadRequest("Incorrect verification code", "OTP_INVALID");
    }

    record.verified = true;
    await record.save();
  }
}
