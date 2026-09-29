import { MOBILE_PATTERN, maskPhone, normalizePhone, toWhatsAppRecipient } from "./phone-number";

describe("normalizePhone", () => {
  it.each([
    ["9876543210", "+919876543210"],
    ["98765 43210", "+919876543210"],
    ["098765-43210", "+919876543210"],
    ["919876543210", "+919876543210"],
    ["+91 98765 43210", "+919876543210"],
    ["+91-98765-43210", "+919876543210"],
    ["(+91) 98765 43210", "+919876543210"],
    ["0091 98765 43210", "+919876543210"],
    ["+1 415 555 0123", "+14155550123"],
  ])("%s -> %s", (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it("leaves non-strings to the validators", () => {
    expect(normalizePhone(42)).toBe(42);
    expect(normalizePhone(undefined)).toBeUndefined();
  });
});

describe("MOBILE_PATTERN", () => {
  it("accepts Indian mobiles and other E.164 numbers", () => {
    expect(MOBILE_PATTERN.test("+919876543210")).toBe(true);
    expect(MOBILE_PATTERN.test("+916000000000")).toBe(true);
    expect(MOBILE_PATTERN.test("+14155550123")).toBe(true);
  });

  it("rejects Indian landlines, short numbers and missing country codes", () => {
    expect(MOBILE_PATTERN.test("+911123456789")).toBe(false);
    expect(MOBILE_PATTERN.test("+91987654321")).toBe(false);
    expect(MOBILE_PATTERN.test("+9198765432100")).toBe(false);
    expect(MOBILE_PATTERN.test("9876543210")).toBe(false);
  });
});

describe("WhatsApp formatting", () => {
  it("sends digits only to Meta", () => {
    expect(toWhatsAppRecipient("+919876543210")).toBe("919876543210");
  });

  it("masks all but the last four digits, in plain ASCII", () => {
    expect(maskPhone("+919876543210")).toBe("+91 ***** *3210");
    expect(maskPhone("+14155550123")).toBe("+1 ***** *0123");
  });
});
