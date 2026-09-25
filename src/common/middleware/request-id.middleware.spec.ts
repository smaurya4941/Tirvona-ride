import { resolveRequestId } from "./request-id.middleware";

describe("resolveRequestId", () => {
  it("keeps a safe client-supplied id", () => {
    expect(resolveRequestId("mobile-abc_123:4")).toBe("mobile-abc_123:4");
  });

  it.each([undefined, "", "has spaces", "<script>", "x".repeat(129)])(
    "replaces unsafe id %p with a UUID",
    (supplied) => {
      expect(resolveRequestId(supplied)).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    },
  );
});
