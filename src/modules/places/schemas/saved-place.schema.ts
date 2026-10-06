import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, Types } from "mongoose";
import type { HydratedDocument } from "mongoose";

export enum SavedPlaceKind {
  HOME = "home",
  WORK = "work",
  /** A rider-named place ("Gym", "Mom's house"); a rider may keep several. */
  OTHER = "other",
}

/** The one-per-rider shortcuts (PUT/DELETE /places/saved/:kind). */
export const FIXED_SAVED_PLACE_KINDS = [
  SavedPlaceKind.HOME,
  SavedPlaceKind.WORK,
] as const;
export type FixedSavedPlaceKind = (typeof FIXED_SAVED_PLACE_KINDS)[number];

/** The pre-"other" unique (userId, kind) index, dropped on startup (it allowed one place per kind). */
export const LEGACY_KIND_INDEX_NAME = "userId_1_kind_1";

/**
 * A rider's saved address: at most one Home and one Work, plus any number
 * (up to the service limit) of labelled "other" places. Kept on the server
 * so the shortcuts follow the rider to a new phone.
 */
@Schema({ timestamps: true, collection: "saved_places" })
export class SavedPlace {
  @Prop({ required: true, type: SchemaTypes.ObjectId, ref: "User" })
  userId!: Types.ObjectId;

  @Prop({ required: true, enum: SavedPlaceKind })
  kind!: SavedPlaceKind;

  /**
   * Equal to `kind` for Home and Work, unset for "other" places. Carries the
   * one-Home-one-Work rule as a plain partial unique index (a filter on
   * `kind` would need `$in`, which older MongoDB servers reject there).
   */
  @Prop({ enum: FIXED_SAVED_PLACE_KINDS })
  slot?: FixedSavedPlaceKind;

  /** The rider's name for an "other" place ("Gym"). Unset for Home and Work. */
  @Prop({ trim: true, maxlength: 40 })
  label?: string;

  /** Lower-cased label: one "Gym" per rider regardless of case. */
  @Prop({ select: false })
  labelKey?: string;

  /** Short label ("Tower B, Supertech Capetown"); falls back to the address. */
  @Prop({ trim: true, maxlength: 120 })
  name?: string;

  /** One-line address the ride is booked with (≤ 200, the ride DTO limit). */
  @Prop({ required: true, trim: true, maxlength: 200 })
  address!: string;

  @Prop({ required: true, min: -90, max: 90 })
  latitude!: number;

  @Prop({ required: true, min: -180, max: 180 })
  longitude!: number;

  createdAt!: Date;
  updatedAt!: Date;
}

export type SavedPlaceDocument = HydratedDocument<SavedPlace>;
export const SavedPlaceSchema = SchemaFactory.createForClass(SavedPlace);

SavedPlaceSchema.index(
  { userId: 1, slot: 1 },
  { unique: true, partialFilterExpression: { slot: { $exists: true } } },
);
SavedPlaceSchema.index(
  { userId: 1, labelKey: 1 },
  { unique: true, partialFilterExpression: { labelKey: { $exists: true } } },
);
// The rider's list, oldest first.
SavedPlaceSchema.index({ userId: 1, createdAt: 1 });
