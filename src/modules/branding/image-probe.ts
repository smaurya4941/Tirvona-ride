/**
 * Reads the format and pixel size of an uploaded image from its header
 * bytes — never from the client's filename or declared MIME type. No image
 * library: only the three formats the apps can render are recognised.
 */

export type ImageFormat = "png" | "jpeg" | "webp";

export interface ImageInfo {
  format: ImageFormat;
  contentType: `image/${ImageFormat}`;
  width: number;
  height: number;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function probeImage(data: Buffer): ImageInfo | null {
  if (data.length >= 24 && data.subarray(0, 8).equals(PNG_SIGNATURE) && data.toString("ascii", 12, 16) === "IHDR")
    return info("png", data.readUInt32BE(16), data.readUInt32BE(20));
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return probeJpeg(data);
  if (data.length >= 30 && data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP")
    return probeWebp(data);
  return null;
}

function info(format: ImageFormat, width: number, height: number): ImageInfo | null {
  if (!width || !height) return null;
  return { format, contentType: `image/${format}`, width, height };
}

/** Walks the JPEG segments to the first start-of-frame marker. */
function probeJpeg(data: Buffer): ImageInfo | null {
  let offset = 2;
  while (offset + 9 < data.length) {
    if (data[offset] !== 0xff) return null;
    const marker = data[offset + 1];
    // Fill bytes and standalone markers carry no length.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = data.readUInt16BE(offset + 2);
    const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isStartOfFrame) return info("jpeg", data.readUInt16BE(offset + 7), data.readUInt16BE(offset + 5));
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}

function probeWebp(data: Buffer): ImageInfo | null {
  const chunk = data.toString("ascii", 12, 16);
  if (chunk === "VP8 " && data[23] === 0x9d && data[24] === 0x01 && data[25] === 0x2a)
    return info("webp", data.readUInt16LE(26) & 0x3fff, data.readUInt16LE(28) & 0x3fff);
  if (chunk === "VP8L" && data[20] === 0x2f) {
    const bits = data.readUInt32LE(21);
    return info("webp", (bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
  }
  if (chunk === "VP8X") return info("webp", data.readUIntLE(24, 3) + 1, data.readUIntLE(27, 3) + 1);
  return null;
}
