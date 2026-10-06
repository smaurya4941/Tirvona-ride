import { BrandAssetKind, brandAssetProblem } from "./branding-rules";
import { probeImage } from "./image-probe";

/** Minimal headers — enough bytes for the probe, not decodable images. */
function pngHeader(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function jpegHeader(width: number, height: number): Buffer {
  const app0 = Buffer.from([
    0xff,
    0xe0,
    0x00,
    0x10,
    ...Buffer.from("JFIF\0"),
    1,
    1,
    0,
    0,
    1,
    0,
    1,
    0,
    0,
  ]);
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]);
}

function webpVp8xHeader(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(30);
  buffer.write("RIFF", 0, "ascii");
  buffer.write("WEBP", 8, "ascii");
  buffer.write("VP8X", 12, "ascii");
  buffer.writeUIntLE(width - 1, 24, 3);
  buffer.writeUIntLE(height - 1, 27, 3);
  return buffer;
}

describe("probeImage", () => {
  it("reads PNG dimensions", () => {
    expect(probeImage(pngHeader(1349, 911))).toEqual({
      format: "png",
      contentType: "image/png",
      width: 1349,
      height: 911,
    });
  });

  it("reads JPEG dimensions from the start-of-frame segment", () => {
    expect(probeImage(jpegHeader(1080, 2340))).toMatchObject({
      format: "jpeg",
      width: 1080,
      height: 2340,
    });
  });

  it("reads extended WEBP dimensions", () => {
    expect(probeImage(webpVp8xHeader(854, 1842))).toMatchObject({
      format: "webp",
      contentType: "image/webp",
      width: 854,
      height: 1842,
    });
  });

  it("rejects anything else, whatever it claims to be", () => {
    expect(
      probeImage(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>")),
    ).toBeNull();
    expect(probeImage(Buffer.from("%PDF-1.7 ..."))).toBeNull();
    expect(probeImage(Buffer.alloc(0))).toBeNull();
    expect(probeImage(pngHeader(0, 10))).toBeNull();
  });
});

describe("brandAssetProblem", () => {
  it("accepts a landscape logo and a portrait splash", () => {
    expect(
      brandAssetProblem(
        BrandAssetKind.LOGO,
        200_000,
        probeImage(pngHeader(1349, 911)),
      ),
    ).toBeNull();
    expect(
      brandAssetProblem(
        BrandAssetKind.SPLASH,
        1_500_000,
        probeImage(pngHeader(1080, 2340)),
      ),
    ).toBeNull();
  });

  it("explains what is wrong", () => {
    expect(brandAssetProblem(BrandAssetKind.LOGO, 10, null)).toMatch(
      /PNG, JPEG or WEBP/,
    );
    expect(
      brandAssetProblem(
        BrandAssetKind.LOGO,
        2 * 1024 * 1024,
        probeImage(pngHeader(1000, 600)),
      ),
    ).toMatch(/at most 1 MB/);
    expect(
      brandAssetProblem(
        BrandAssetKind.LOGO,
        10,
        probeImage(pngHeader(200, 100)),
      ),
    ).toMatch(/at least 400/);
    expect(
      brandAssetProblem(
        BrandAssetKind.LOGO,
        10,
        probeImage(pngHeader(400, 900)),
      ),
    ).toMatch(/landscape or square/);
    expect(
      brandAssetProblem(
        BrandAssetKind.SPLASH,
        10,
        probeImage(pngHeader(1920, 1080)),
      ),
    ).toMatch(/at least 720 × 1280/);
    expect(
      brandAssetProblem(
        BrandAssetKind.SPLASH,
        10,
        probeImage(pngHeader(1280, 1400)),
      ),
    ).toMatch(/portrait/);
  });
});
