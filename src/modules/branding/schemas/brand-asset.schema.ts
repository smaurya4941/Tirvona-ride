import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, Types } from "mongoose";
import type { HydratedDocument } from "mongoose";
import { BrandAssetKind } from "../branding-rules";

/**
 * An admin-uploaded brand image (one per kind). The bytes live in MongoDB,
 * not on local disk, so they survive redeploys on ephemeral hosts and every
 * API instance serves the same file. Images are small (≤ 3 MB). No document
 * for a kind means "use the default bundled in each app".
 */
@Schema({ timestamps: true, collection: "brand_assets" })
export class BrandAsset {
  @Prop({ required: true, enum: BrandAssetKind, unique: true })
  kind!: BrandAssetKind;

  @Prop({ required: true })
  contentType!: string;

  /** Never loaded unless asked for (`.select("+data")`). */
  @Prop({ required: true, type: Buffer, select: false })
  data!: Buffer;

  @Prop({ required: true })
  bytes!: number;

  @Prop({ required: true })
  width!: number;

  @Prop({ required: true })
  height!: number;

  /** First 16 hex chars of the SHA-256 of `data`; clients cache by it. */
  @Prop({ required: true })
  version!: string;

  @Prop({ trim: true })
  originalName?: string;

  @Prop({ type: SchemaTypes.ObjectId, ref: "User" })
  updatedBy?: Types.ObjectId;

  createdAt!: Date;
  updatedAt!: Date;
}

export type BrandAssetDocument = HydratedDocument<BrandAsset>;
export const BrandAssetSchema = SchemaFactory.createForClass(BrandAsset);
