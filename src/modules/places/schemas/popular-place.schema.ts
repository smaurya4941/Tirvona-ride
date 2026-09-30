import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, Types } from "mongoose";
import type { HydratedDocument } from "mongoose";
import { GeoPoint, GeoPointSchema } from "../../../common/schemas/geo-point.schema";

/**
 * A destination shown under "Popular destinations" on the rider's Home and
 * search screens. Admin-managed (Configuration → Popular places); the first
 * boot seeds the Braj landmarks and a Noida/NCR set (popular-places.seed.ts).
 *
 * Riders only see active places within PLACES_FEATURED_RADIUS_KM of where
 * they are, nearest first — so a pilgrim in Vrindavan sees temples and a
 * rider in Noida sees malls and metro stations.
 */
@Schema({ _id: false })
export class PopularPlaceImage {
  @Prop({ required: true })
  contentType!: string;

  /** Never loaded unless asked for (`.select("+image.data")`). */
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
}
const PopularPlaceImageSchema = SchemaFactory.createForClass(PopularPlaceImage);

@Schema({ timestamps: true, collection: "popular_places" })
export class PopularPlace {
  @Prop({ required: true, trim: true, maxlength: 80 })
  name!: string;

  /** Second list line: "Sector 32, Noida". */
  @Prop({ required: true, trim: true, maxlength: 120 })
  secondaryText!: string;

  /** Drop-off point (main gate), GeoJSON [lng, lat]. */
  @Prop({ required: true, type: GeoPointSchema })
  location!: GeoPoint;

  /** Area label used to group places in the admin list: "Vrindavan", "Noida". */
  @Prop({ required: true, trim: true, maxlength: 60 })
  city!: string;

  @Prop({ required: true, default: true })
  active!: boolean;

  /** Lower first when the rider's position is unknown. */
  @Prop({ required: true, default: 100, min: 0, max: 10_000 })
  sortOrder!: number;

  @Prop({ type: PopularPlaceImageSchema })
  image?: PopularPlaceImage;

  @Prop({ type: SchemaTypes.ObjectId, ref: "User" })
  updatedBy?: Types.ObjectId;

  createdAt!: Date;
  updatedAt!: Date;
}

export type PopularPlaceDocument = HydratedDocument<PopularPlace>;
export const PopularPlaceSchema = SchemaFactory.createForClass(PopularPlace);

PopularPlaceSchema.index({ location: "2dsphere", active: 1 });
PopularPlaceSchema.index({ active: 1, sortOrder: 1, name: 1 });
