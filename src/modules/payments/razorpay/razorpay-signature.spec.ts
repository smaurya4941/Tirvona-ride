import { createHmac } from "node:crypto";
import {
  razorpayPaymentSignature,
  razorpayWebhookSignature,
  verifyPaymentSignature,
  verifyWebhookSignature,
} from "./razorpay-signature";

const SECRET = "test_key_secret";

describe("Razorpay checkout signature", () => {
  it("matches Razorpay's documented construction HMAC_SHA256(order_id|payment_id)", () => {
    const expected = createHmac("sha256", SECRET).update("order_ABC123|pay_XYZ789").digest("hex");
    expect(razorpayPaymentSignature("order_ABC123", "pay_XYZ789", SECRET)).toBe(expected);
  });

  it("accepts a genuine signature (case-insensitive hex)", () => {
    const signature = razorpayPaymentSignature("order_ABC123", "pay_XYZ789", SECRET);
    expect(verifyPaymentSignature("order_ABC123", "pay_XYZ789", signature, SECRET)).toBe(true);
    expect(verifyPaymentSignature("order_ABC123", "pay_XYZ789", signature.toUpperCase(), SECRET)).toBe(true);
  });

  it("rejects a signature for another order, another payment or another secret", () => {
    const signature = razorpayPaymentSignature("order_ABC123", "pay_XYZ789", SECRET);
    expect(verifyPaymentSignature("order_OTHER1", "pay_XYZ789", signature, SECRET)).toBe(false);
    expect(verifyPaymentSignature("order_ABC123", "pay_OTHER1", signature, SECRET)).toBe(false);
    expect(verifyPaymentSignature("order_ABC123", "pay_XYZ789", signature, "another_secret")).toBe(false);
  });

  it("rejects malformed input without throwing", () => {
    expect(verifyPaymentSignature("order_ABC123", "pay_XYZ789", "not-hex", SECRET)).toBe(false);
    expect(verifyPaymentSignature("order_ABC123", "pay_XYZ789", "abcd", SECRET)).toBe(false);
    expect(verifyPaymentSignature("order_ABC123", "pay_XYZ789", "", SECRET)).toBe(false);
    expect(verifyPaymentSignature("order_ABC123", "pay_XYZ789", "a".repeat(64), "")).toBe(false);
  });
});

describe("Razorpay webhook signature", () => {
  const body = Buffer.from('{"entity":"event","event":"payment.captured","payload":{}}');

  it("verifies over the exact raw bytes", () => {
    const signature = razorpayWebhookSignature(body, "whsec");
    expect(verifyWebhookSignature(body, signature, "whsec")).toBe(true);
  });

  it("fails if the body was re-serialised or altered", () => {
    const signature = razorpayWebhookSignature(body, "whsec");
    const reformatted = Buffer.from(JSON.stringify(JSON.parse(body.toString()), null, 2));
    expect(verifyWebhookSignature(reformatted, signature, "whsec")).toBe(false);
    expect(verifyWebhookSignature(body, signature, "other")).toBe(false);
    expect(verifyWebhookSignature(undefined, signature, "whsec")).toBe(false);
    expect(verifyWebhookSignature(body, undefined, "whsec")).toBe(false);
  });
});
