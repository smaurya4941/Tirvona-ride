import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, Types } from "mongoose";
import type { HydratedDocument } from "mongoose";
import type { GeoJsonPolygon } from "../zone-geometry";

export enum ZoneStatus {
  ACTIVE = "ACTIVE",
  INACTIVE = "INACTIVE",
}

@Schema({ _id: false })
export class ZoneBoundary {
  @Prop({ required: true, enum: ["Polygon"] })
  type!: "Polygon";

  /** [[ [lng, lat], … closed ring ]] — GeoJSON order. */
  @Prop({ required: true, type: SchemaTypes.Mixed })
  coordinates!: GeoJsonPolygon["coordinates"];
}
const ZoneBoundarySchema = SchemaFactory.createForClass(ZoneBoundary);

/**
 * A service area. Phase 7 uses zones for service availability (pickups
 * outside every active zone are refused once any zone is active) and tags
 * each ride with its pickup zone for zone-based reporting. Zone pricing is
 * deliberately not modelled yet.
 */
@Schema({ timestamps: true, collection: "zones" })
export class Zone {
  @Prop({ required: true, trim: true })
  name!: string;

  /** Lower-cased name: uniqueness without a case-insensitive collation. */
  @Prop({ required: true })
  nameKey!: string;

  @Prop({ trim: true })
  city?: string;

  @Prop({ trim: true })
  description?: string;

  @Prop({ required: true, enum: ZoneStatus, default: ZoneStatus.ACTIVE })
  status!: ZoneStatus;

  @Prop({ required: true, type: ZoneBoundarySchema })
  boundary!: ZoneBoundary;

  @Prop({ type: SchemaTypes.ObjectId, ref: "User" })
  createdBy?: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: "User" })
  updatedBy?: Types.ObjectId;
}

export type ZoneDocument = HydratedDocument<Zone>;
export const ZoneSchema = SchemaFactory.createForClass(Zone);

ZoneSchema.index({ nameKey: 1 }, { unique: true });
ZoneSchema.index({ status: 1, name: 1 });
// Point-in-zone lookups at booking ($geoIntersects).
ZoneSchema.index({ boundary: "2dsphere" });
