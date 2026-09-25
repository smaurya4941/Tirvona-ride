import { createSign } from "node:crypto";

export const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

const base64Url = (input: string | Buffer): string => Buffer.from(input).toString("base64url");

/**
 * A signed service-account assertion (RFC 7523) that Google exchanges for
 * an OAuth access token. Pure apart from the clock, so it is unit-tested
 * against a throwaway key.
 */
export function serviceAccountAssertion(
  clientEmail: string,
  privateKeyPem: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): string {
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64Url(
    JSON.stringify({
      iss: clientEmail,
      scope: FCM_SCOPE,
      aud: GOOGLE_TOKEN_URL,
      iat: nowSeconds,
      exp: nowSeconds + 3600,
    }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${base64Url(signer.sign(privateKeyPem))}`;
}
