import type { ImageInfo } from "./image-probe";

export enum BrandAssetKind {
  LOGO = "logo",
  SPLASH = "splash",
}

export interface BrandAssetRule {
  label: string;
  maxBytes: number;
  minWidth: number;
  minHeight: number;
  /** height ÷ width */
  minAspect: number;
  maxAspect: number;
  hint: string;
}

/**
 * What the apps can display well. The logo is shown on light backgrounds
 * (sign-in, receipts, admin sidebar) at up to ~300 dp wide; the splash fills
 * a portrait phone screen with `cover`, so its edges may be cropped.
 */
export const BRAND_ASSET_RULES: Record<BrandAssetKind, BrandAssetRule> = {
  [BrandAssetKind.LOGO]: {
    label: "Logo",
    maxBytes: 1024 * 1024,
    minWidth: 400,
    minHeight: 100,
    minAspect: 0.25,
    maxAspect: 1.5,
    hint: "PNG (transparent background recommended), JPEG or WEBP, at least 400 px wide, landscape or square, up to 1 MB",
  },
  [BrandAssetKind.SPLASH]: {
    label: "Splash screen",
    maxBytes: 3 * 1024 * 1024,
    minWidth: 720,
    minHeight: 1280,
    minAspect: 1.6,
    maxAspect: 2.4,
    hint: "Portrait PNG, JPEG or WEBP, at least 720 × 1280 px (1080 × 2340 recommended), up to 3 MB; keep the bottom 15% clear for the loading indicator",
  },
};

/** Largest file any kind accepts — the multer limit. */
export const MAX_BRAND_ASSET_BYTES = Math.max(
  ...Object.values(BRAND_ASSET_RULES).map((rule) => rule.maxBytes),
);

/** Returns why the image cannot be used as `kind`, or null if it can. */
export function brandAssetProblem(
  kind: BrandAssetKind,
  bytes: number,
  image: ImageInfo | null,
): string | null {
  const rule = BRAND_ASSET_RULES[kind];
  if (!image) return `${rule.label} must be a PNG, JPEG or WEBP image`;
  if (bytes > rule.maxBytes)
    return `${rule.label} must be at most ${Math.round(rule.maxBytes / 1024 / 1024)} MB`;
  if (image.width < rule.minWidth || image.height < rule.minHeight)
    return `${rule.label} must be at least ${rule.minWidth} × ${rule.minHeight} px (got ${image.width} × ${image.height})`;
  const aspect = image.height / image.width;
  if (aspect < rule.minAspect || aspect > rule.maxAspect)
    return kind === BrandAssetKind.SPLASH
      ? `Splash screen must be a portrait phone image (height about 1.6–2.4 × width, got ${image.width} × ${image.height})`
      : `Logo must be landscape or square (got ${image.width} × ${image.height})`;
  return null;
}
