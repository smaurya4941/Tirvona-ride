import type { ImageInfo } from "../branding/image-probe";

/**
 * Circuit cover images are the hero of the package card and details screen,
 * so they may be larger and sharper than popular-place thumbnails. Kept in
 * MongoDB with the package (well under the 16 MB document limit).
 */
export const CIRCUIT_COVER_RULE = {
  maxBytes: 5 * 1024 * 1024,
  minWidth: 640,
  minHeight: 360,
  /** height ÷ width: landscape, from a wide banner (0.4) to almost square (1.1). */
  minAspect: 0.4,
  maxAspect: 1.1,
  hint: "Landscape PNG, JPEG or WEBP, at least 640 × 360 px (1600 × 1000 recommended), up to 5 MB",
} as const;

export type CoverRule = typeof CIRCUIT_COVER_RULE;

const megabytes = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(bytes % (1024 * 1024) === 0 ? 0 : 1)} MB`;

/** Why the upload cannot be a cover image, or null if it can. Reads the real bytes, never the file name. */
export function coverProblem(bytes: number, image: ImageInfo | null, rule: CoverRule = CIRCUIT_COVER_RULE): string | null {
  if (!image) return "Cover must be a PNG, JPEG or WEBP image";
  if (bytes > rule.maxBytes) return `Cover must be at most ${megabytes(rule.maxBytes)} (this one is ${megabytes(bytes)})`;
  if (image.width < rule.minWidth || image.height < rule.minHeight)
    return `Cover must be at least ${rule.minWidth} × ${rule.minHeight} px (got ${image.width} × ${image.height})`;
  const aspect = image.height / image.width;
  if (aspect < rule.minAspect || aspect > rule.maxAspect)
    return `Cover must be landscape (height ${rule.minAspect}–${rule.maxAspect} × width, got ${image.width} × ${image.height})`;
  return null;
}
