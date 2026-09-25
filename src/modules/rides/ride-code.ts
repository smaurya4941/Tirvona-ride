import { randomInt } from "node:crypto";

// No 0/O, 1/I/L — codes get read aloud to support over the phone.
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/** "TR" + 8 random characters ≈ 8.5 × 10^11 combinations. */
export function generateRideCode(): string {
  let code = "TR";
  for (let index = 0; index < 8; index += 1) code += ALPHABET[randomInt(ALPHABET.length)];
  return code;
}
