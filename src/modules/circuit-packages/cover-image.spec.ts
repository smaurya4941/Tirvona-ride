import { CIRCUIT_COVER_RULE, coverProblem } from "./cover-image";

const png = (width: number, height: number) => ({
  format: "png" as const,
  contentType: "image/png" as const,
  width,
  height,
});
const MB = 1024 * 1024;

describe("circuit cover rule", () => {
  it("accepts large landscape images up to 5 MB", () => {
    expect(CIRCUIT_COVER_RULE.maxBytes).toBe(5 * MB);
    expect(coverProblem(4.9 * MB, png(1920, 1080))).toBeNull();
    expect(coverProblem(5 * MB, png(1600, 1000))).toBeNull();
  });

  it("rejects what cannot be a good cover", () => {
    expect(coverProblem(100, null)).toContain("PNG, JPEG or WEBP");
    expect(coverProblem(5 * MB + 1, png(1920, 1080))).toContain("at most 5 MB");
    expect(coverProblem(MB, png(600, 400))).toContain("at least 640 × 360");
    expect(coverProblem(MB, png(1000, 1500))).toContain("landscape");
    expect(coverProblem(MB, png(3000, 900))).toContain("landscape");
  });
});
