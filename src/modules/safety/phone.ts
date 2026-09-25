/** E.164, the format every phone number in Tirvona is stored in. */
export const E164_PATTERN = /^\+[1-9]\d{7,14}$/;

/**
 * Normalises what people type for an Indian mobile number ("98765 43210",
 * "098765-43210", "919876543210") to E.164. Anything already international
 * is only stripped of separators; validation happens afterwards.
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
