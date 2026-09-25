import { createHmac, timingSafeEqual } from "node:crypto";

const hmacHex = (secret: string, payload: string | Buffer): string =>
  createHmac("sha256", secret).update(payload).digest("hex");

/** Constant-time comparison of two hex digests (false on any shape mismatch). */
function sameHex(expected: string, received: string): boolean {
  if (!/^[0-9a-f]+$/i.test(received) || expected.length !== received.length) return false;
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(received.toLowerCase(), "hex"));
}

/**
 * Standard Checkout signature: HMAC-SHA256(`${order_id}|${payment_id}`,
 * key_secret). Proves Razorpay issued this payment for *this* order — the
 * app cannot forge it without the secret, which never leaves the server.
 */
export function razorpayPaymentSignature(orderId: string, paymentId: string, keySecret: string): string {
  return hmacHex(keySecret, `${orderId}|${paymentId}`);
}

export function verifyPaymentSignature(
  orderId: string,
  paymentId: string,
  signature: string,
  keySecret: string,
): boolean {
  if (!orderId || !paymentId || !signature || !keySecret) return false;
  return sameHex(razorpayPaymentSignature(orderId, paymentId, keySecret), signature);
}

/**
 * Webhook signature: HMAC-SHA256(raw request body, webhook secret), in the
 * `X-Razorpay-Signature` header. Must be computed over the exact bytes
 * received — never over re-serialised JSON.
 */
export function razorpayWebhookSignature(rawBody: Buffer | string, webhookSecret: string): string {
  return hmacHex(webhookSecret, rawBody);
}

export function verifyWebhookSignature(
  rawBody: Buffer | string | undefined,
  signature: string | undefined,
  webhookSecret: string,
): boolean {
  if (!rawBody || !signature || !webhookSecret) return false;
  return sameHex(razorpayWebhookSignature(rawBody, webhookSecret), signature);
}
