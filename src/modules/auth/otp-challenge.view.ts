import { maskPhone } from "../../common/phone/phone-number";
import type { OtpChallenge } from "./otp.service";

/** Returned whenever a code is sent (or kept): everything the OTP screen shows. */
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

export function toOtpChallengeView(phone: string, challenge: OtpChallenge): OtpChallengeView {
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
