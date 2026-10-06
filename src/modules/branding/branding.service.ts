import { createHash } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Types } from "mongoose";
import type { Model } from "mongoose";
import {
  apiBadRequest,
  apiNotFound,
} from "../../common/exceptions/api.exception";
import {
  BRAND_ASSET_RULES,
  BrandAssetKind,
  brandAssetProblem,
} from "./branding-rules";
import type { BrandAssetRule } from "./branding-rules";
import { probeImage } from "./image-probe";
import { BrandAsset } from "./schemas/brand-asset.schema";

export interface BrandAssetView {
  kind: BrandAssetKind;
  /** Relative to the versioned API base (e.g. `/api/v1`); changes whenever the image does. */
  path: string;
  version: string;
  contentType: string;
  bytes: number;
  width: number;
  height: number;
  updatedAt: Date;
}

/** `null` for a kind means the apps show their bundled default. */
export interface BrandingView {
  logo: BrandAssetView | null;
  splash: BrandAssetView | null;
}

export interface BrandingRulesView {
  kind: BrandAssetKind;
  rule: BrandAssetRule;
}

export interface BrandAssetFile {
  data: Buffer;
  contentType: string;
  version: string;
}

@Injectable()
export class BrandingService {
  constructor(
    @InjectModel(BrandAsset.name) private readonly assets: Model<BrandAsset>,
  ) {}

  async current(): Promise<BrandingView> {
    const assets = await this.assets.find().lean();
    const byKind = new Map(assets.map((asset) => [asset.kind, asset]));
    const view = (kind: BrandAssetKind): BrandAssetView | null => {
      const asset = byKind.get(kind);
      return asset ? this.toView(asset) : null;
    };
    return {
      logo: view(BrandAssetKind.LOGO),
      splash: view(BrandAssetKind.SPLASH),
    };
  }

  rules(): BrandingRulesView[] {
    return Object.values(BrandAssetKind).map((kind) => ({
      kind,
      rule: BRAND_ASSET_RULES[kind],
    }));
  }

  async file(kind: BrandAssetKind): Promise<BrandAssetFile> {
    // Hydrated, not lean: lean returns a BSON Binary instead of a Buffer.
    const asset = await this.assets.findOne({ kind }).select("+data");
    if (!asset)
      throw apiNotFound(
        `No custom ${BRAND_ASSET_RULES[kind].label.toLowerCase()} is set`,
        "BRANDING_NOT_SET",
      );
    return {
      data: asset.data,
      contentType: asset.contentType,
      version: asset.version,
    };
  }

  /** Validates the image by its bytes and replaces the current one for `kind`. */
  async replace(
    kind: BrandAssetKind,
    upload: { buffer: Buffer; originalname?: string },
    adminId: string,
  ): Promise<{ view: BrandAssetView; previousVersion: string | null }> {
    const image = probeImage(upload.buffer);
    const problem = brandAssetProblem(kind, upload.buffer.length, image);
    if (problem || !image)
      throw apiBadRequest(
        problem ?? "Unsupported image",
        "BRANDING_INVALID_IMAGE",
        { hint: BRAND_ASSET_RULES[kind].hint },
      );

    const previous = await this.assets
      .findOne({ kind })
      .select("version")
      .lean();
    const saved = await this.assets
      .findOneAndUpdate(
        { kind },
        {
          $set: {
            contentType: image.contentType,
            data: upload.buffer,
            bytes: upload.buffer.length,
            width: image.width,
            height: image.height,
            version: createHash("sha256")
              .update(upload.buffer)
              .digest("hex")
              .slice(0, 16),
            originalName: upload.originalname?.slice(0, 200),
            updatedBy: new Types.ObjectId(adminId),
          },
        },
        { upsert: true, returnDocument: "after" },
      )
      .lean();
    return {
      view: this.toView(saved),
      previousVersion: previous?.version ?? null,
    };
  }

  /** Back to the apps' bundled default. Returns whether anything was removed. */
  async reset(kind: BrandAssetKind): Promise<boolean> {
    const result = await this.assets.deleteOne({ kind });
    return result.deletedCount > 0;
  }

  private toView(
    asset: Pick<
      BrandAsset,
      | "kind"
      | "contentType"
      | "bytes"
      | "width"
      | "height"
      | "version"
      | "updatedAt"
    >,
  ): BrandAssetView {
    return {
      kind: asset.kind,
      path: `/branding/assets/${asset.kind}?v=${asset.version}`,
      version: asset.version,
      contentType: asset.contentType,
      bytes: asset.bytes,
      width: asset.width,
      height: asset.height,
      updatedAt: asset.updatedAt,
    };
  }
}
