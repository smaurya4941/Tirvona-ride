import { randomInt } from "node:crypto";

// No 0/O, 1/I/L — references get read aloud to support over the phone.
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/** "SOS-7K2M9Q", "TKT-4HX8QW": a human-friendly, random reference. */
export function generateReferenceCode(prefix: string, length = 6): string {
  let code = `${prefix}-`;
  for (let index = 0; index < length; index += 1) code += ALPHABET[randomInt(ALPHABET.length)];
  return code;
}
