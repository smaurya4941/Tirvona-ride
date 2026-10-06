/**
 * Decides what a file really is from its first bytes. The type the client
 * declares (multer's mimetype, the file extension) is only a hint and is never
 * trusted: a renamed HTML or executable must not be stored as a document.
 */
export type DetectedKind = "image" | "pdf";

export interface DetectedFile {
  kind: DetectedKind;
  contentType: "image/jpeg" | "image/png" | "image/webp" | "application/pdf";
  extension: ".jpg" | ".png" | ".webp" | ".pdf";
}

const startsWith = (buffer: Buffer, bytes: number[], offset = 0): boolean =>
  buffer.length >= offset + bytes.length && bytes.every((byte, index) => buffer[offset + index] === byte);

export function detectFile(buffer: Buffer): DetectedFile | null {
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return { kind: "image", contentType: "image/jpeg", extension: ".jpg" };
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return { kind: "image", contentType: "image/png", extension: ".png" };
  // RIFF....WEBP
  if (startsWith(buffer, [0x52, 0x49, 0x46, 0x46]) && startsWith(buffer, [0x57, 0x45, 0x42, 0x50], 8))
    return { kind: "image", contentType: "image/webp", extension: ".webp" };
  // The PDF spec allows a little junk before the header.
  if (buffer.subarray(0, 1024).includes("%PDF-"))
    return { kind: "pdf", contentType: "application/pdf", extension: ".pdf" };
  return null;
}
