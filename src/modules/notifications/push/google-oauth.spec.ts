import { createVerify, generateKeyPairSync } from "node:crypto";
import { FCM_SCOPE, GOOGLE_TOKEN_URL, serviceAccountAssertion } from "./google-oauth";

describe("serviceAccountAssertion", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  it("is an RS256 JWT with the FCM scope, signed by the service account key", () => {
    const token = serviceAccountAssertion("push@tirvona.iam.gserviceaccount.com", pem, 1_700_000_000);
    const [header, claims, signature] = token.split(".");
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(claims, "base64url").toString())).toEqual({
      iss: "push@tirvona.iam.gserviceaccount.com",
      scope: FCM_SCOPE,
      aud: GOOGLE_TOKEN_URL,
      iat: 1_700_000_000,
      exp: 1_700_003_600,
    });
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${claims}`);
    expect(verifier.verify(publicKey, Buffer.from(signature, "base64url"))).toBe(true);
  });
});
