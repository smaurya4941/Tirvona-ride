import { Throttle } from "@nestjs/throttler";
import type { Environment } from "../../config/environment";

/**
 * Per-route rate limits for abuse-prone endpoints. Each is tighter than the
 * app-wide default (THROTTLE_LIMIT per THROTTLE_TTL_MS) and is keyed per
 * client IP *and* per route by ThrottlerGuard, so exhausting the OTP budget
 * never blocks login, and a busy admin report page never blocks anything.
 *
 * Limits come from configuration. The decorator is evaluated at class-load
 * time, before ConfigService exists, so it registers resolver functions that
 * read this table on every request; ThrottlerModule's factory fills it in.
 */
export type ThrottlePolicyName = "auth" | "otpSend" | "otpVerify" | "refresh" | "adminLogin" | "promo";

interface ThrottleWindow {
  limit: number;
  ttl: number;
}

// Safe defaults for unit tests that never boot ThrottlerModule.
const policies: Record<ThrottlePolicyName, ThrottleWindow> = {
  auth: { limit: 10, ttl: 60_000 },
  otpSend: { limit: 3, ttl: 600_000 },
  otpVerify: { limit: 10, ttl: 600_000 },
  refresh: { limit: 30, ttl: 60_000 },
  adminLogin: { limit: 5, ttl: 300_000 },
  promo: { limit: 20, ttl: 60_000 },
};

export function configureThrottlePolicies(
  env: Pick<
    Environment,
    | "throttleAuthLimit"
    | "throttleAuthTtlMs"
    | "throttleOtpSendLimit"
    | "throttleOtpSendTtlMs"
    | "throttleOtpVerifyLimit"
    | "throttleOtpVerifyTtlMs"
    | "throttleRefreshLimit"
    | "throttleRefreshTtlMs"
    | "throttleAdminLoginLimit"
    | "throttleAdminLoginTtlMs"
    | "throttlePromoLimit"
    | "throttlePromoTtlMs"
  >,
): void {
  policies.auth = { limit: env.throttleAuthLimit, ttl: env.throttleAuthTtlMs };
  policies.otpSend = { limit: env.throttleOtpSendLimit, ttl: env.throttleOtpSendTtlMs };
  policies.otpVerify = { limit: env.throttleOtpVerifyLimit, ttl: env.throttleOtpVerifyTtlMs };
  policies.refresh = { limit: env.throttleRefreshLimit, ttl: env.throttleRefreshTtlMs };
  policies.adminLogin = { limit: env.throttleAdminLoginLimit, ttl: env.throttleAdminLoginTtlMs };
  policies.promo = { limit: env.throttlePromoLimit, ttl: env.throttlePromoTtlMs };
}

export const throttlePolicy = (name: ThrottlePolicyName): Readonly<ThrottleWindow> => policies[name];

/** Applies the named policy to a route (overrides the "default" throttler). */
export const ThrottlePolicy = (name: ThrottlePolicyName): MethodDecorator & ClassDecorator =>
  Throttle({
    default: {
      limit: () => policies[name].limit,
      ttl: () => policies[name].ttl,
    },
  });
