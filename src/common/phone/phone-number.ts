import { applyDecorators } from "@nestjs/common";
import { Transform } from "class-transformer";
import { IsString, Matches } from "class-validator";

/** E.164, the format every phone number in Tirvona is stored in. */
export const E164_PATTERN = /^\+[1-9]\d{7,14}$/;

/**
 * A number Tirvona accepts as a user's mobile: E.164, and when it is Indian
 * (+91) a real 10-digit mobile starting 6–9 — landlines and short codes can
 * never receive the WhatsApp signup code.
 */
export const MOBILE_PATTERN = /^(?:\+91[6-9]\d{9}|\+(?!91)[1-9]\d{7,14})$/;

/**
 * Normalises what people type for an Indian mobile number ("98765 43210",
 * "098765-43210", "919876543210", "+91 98765 43210") to E.164, so the same
 * phone is always the same string — in users, OTP records, the WhatsApp
 * recipient and every lookup. Anything already international is only
 * stripped of separators; validation happens afterwards.
 */
export function normalizePhone(input: unknown): unknown {
  if (typeof input !== "string") return input;
  const compact = input.replace(/[\s\-().]/g, "");
  if (/^[6-9]\d{9}$/.test(compact)) return `+91${compact}`;
  if (/^0[6-9]\d{9}$/.test(compact)) return `+91${compact.slice(1)}`;
  if (/^91[6-9]\d{9}$/.test(compact)) return `+${compact}`;
  if (/^00[1-9]\d{7,14}$/.test(compact)) return `+${compact.slice(2)}`;
  return compact;
}

/** Meta's Cloud API wants the recipient as digits only, country code first. */
export const toWhatsAppRecipient = (e164: string): string =>
  e164.replace(/^\+/, "");

/** "+919876543210" -> "+91 ***** *3210": safe for logs (plain ASCII) and API responses. */
export function maskPhone(e164: string): string {
  const digits = e164.replace(/^\+/, "");
  const country = e164.startsWith("+91")
    ? "91"
    : digits.slice(0, Math.max(1, digits.length - 10));
  const local = digits.slice(country.length);
  const visible = local.slice(-4);
  const hidden = "*".repeat(Math.max(0, local.length - 4));
  const grouped = `${hidden}${visible}`.replace(/^(.{5})(.+)$/, "$1 $2");
  return `+${country} ${grouped}`;
}

/**
 * DTO decorator for a user's own mobile number: normalises the input, then
 * requires a mobile Tirvona can reach. Used by signup, OTP and login so a
 * number typed any way resolves to the same account.
 */
export const IsMobileNumber = (): PropertyDecorator =>
  applyDecorators(
    Transform(({ value }) => normalizePhone(value)),
    IsString(),
    Matches(MOBILE_PATTERN, {
      message: "phone must be a valid mobile number, e.g. +919876543210",
    }),
  );
