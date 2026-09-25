import { randomInt, timingSafeEqual } from "node:crypto";

export const RIDE_OTP_LENGTH = 4;

/** Cryptographically random, zero-padded 4-digit code. */
export const generateRideOtp = (): string =>
  randomInt(0, 10 ** RIDE_OTP_LENGTH)
    .toString()
    .padStart(RIDE_OTP_LENGTH, "0");

/** Constant-time comparison; false for any length mismatch. */
export function rideOtpMatches(submitted: string, expected: string | undefined): boolean {
  if (!expected) return false;
  const a = Buffer.from(submitted);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
