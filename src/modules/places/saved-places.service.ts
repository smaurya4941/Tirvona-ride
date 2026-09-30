import { Injectable, Logger } from "@nestjs/common";
import type { OnModuleInit } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Types } from "mongoose";
import type { Model } from "mongoose";
import { apiBadRequest, apiConflict, apiNotFound } from "../../common/exceptions/api.exception";
import { clampAddress } from "./place-text";
import { FIXED_SAVED_PLACE_KINDS, LEGACY_KIND_INDEX_NAME, SavedPlace, SavedPlaceKind } from "./schemas/saved-place.schema";
import type { FixedSavedPlaceKind } from "./schemas/saved-place.schema";

/** Labelled places a rider may keep besides Home and Work. */
export const MAX_OTHER_SAVED_PLACES = 20;

export interface SavedPlaceInput {
  name?: string;
  address: string;
  latitude: number;
  longitude: number;
}

export interface OtherSavedPlaceInput extends SavedPlaceInput {
  label: string;
}

export interface SavedPlaceView {
  id: string;
  kind: SavedPlaceKind;
  /** The rider's name for an "other" place; null for Home and Work. */
  label: string | null;
  name: string | null;
  address: string;
  latitude: number;
  longitude: number;
  updatedAt: Date;
}

/** Home and Work are `null` until set ("Add address" in the apps); `others` oldest first. */
export interface SavedPlacesView {
  home: SavedPlaceView | null;
  work: SavedPlaceView | null;
  others: SavedPlaceView[];
  /** How many more "other" places the rider can add. */
  othersRemaining: number;
}

const isDuplicateKey = (error: unknown): boolean => (error as { code?: number } | undefined)?.code === 11000;

const labelKey = (label: string): string => label.trim().replace(/\s+/g, " ").toLowerCase();

/** "home" / "work" as a label would shadow the real shortcuts. */
const RESERVED_LABELS = new Set(["home", "work"]);

/** The rider's saved addresses: the Home and Work shortcuts plus their own labelled places. */
@Injectable()
export class SavedPlacesService implements OnModuleInit {
  private readonly logger = new Logger(SavedPlacesService.name);

  constructor(@InjectModel(SavedPlace.name) private readonly saved: Model<SavedPlace>) {}

  /**
   * Before "other" places the collection had a unique (userId, kind) index,
   * which would allow a single "other" per rider. Replace it with the
   * slot-based rule, backfilling `slot` on existing Home/Work rows first.
   * Runs in every environment (production has autoIndex off).
   */
  async onModuleInit(): Promise<void> {
    try {
      for (const kind of FIXED_SAVED_PLACE_KINDS)
        await this.saved.updateMany({ kind, slot: { $exists: false } }, { $set: { slot: kind } }).exec();
      const indexes = await this.saved.collection.indexes();
      if (indexes.some((index) => index.name === LEGACY_KIND_INDEX_NAME)) {
        await this.saved.collection.dropIndex(LEGACY_KIND_INDEX_NAME);
        this.logger.log(`Dropped legacy index saved_places.${LEGACY_KIND_INDEX_NAME}`);
      }
      await this.saved.createIndexes();
    } catch (error) {
      this.logger.warn(`Could not prepare saved_places indexes: ${(error as Error).message}`);
    }
  }

  async forUser(userId: string): Promise<SavedPlacesView> {
    const rows = await this.saved.find({ userId: new Types.ObjectId(userId) }).sort({ createdAt: 1, _id: 1 }).lean();
    const fixed = (kind: FixedSavedPlaceKind): SavedPlaceView | null => {
      const row = rows.find((candidate) => candidate.kind === kind);
      return row ? toView(row) : null;
    };
    const others = rows.filter((row) => row.kind === SavedPlaceKind.OTHER).map(toView);
    return {
      home: fixed(SavedPlaceKind.HOME),
      work: fixed(SavedPlaceKind.WORK),
      others,
      othersRemaining: Math.max(0, MAX_OTHER_SAVED_PLACES - others.length),
    };
  }

  /** Sets or replaces Home or Work. */
  async save(userId: string, kind: FixedSavedPlaceKind, input: SavedPlaceInput): Promise<SavedPlacesView> {
    const name = input.name?.trim();
    const write = () =>
      this.saved.findOneAndUpdate(
        { userId: new Types.ObjectId(userId), slot: kind },
        {
          $set: {
            kind,
            address: clampAddress(input.address),
            latitude: input.latitude,
            longitude: input.longitude,
            ...(name ? { name } : {}),
          },
          ...(name ? {} : { $unset: { name: 1 } }),
        },
        { upsert: true, runValidators: true },
      );
    try {
      await write();
    } catch (error) {
      // Two first saves raced on the unique index: the second one updates.
      if (!isDuplicateKey(error)) throw error;
      await write();
    }
    return this.forUser(userId);
  }

  async clear(userId: string, kind: FixedSavedPlaceKind): Promise<SavedPlacesView> {
    await this.saved.deleteOne({ userId: new Types.ObjectId(userId), slot: kind });
    return this.forUser(userId);
  }

  // ── "Other" places ───────────────────────────────────────────────────

  async addOther(userId: string, input: OtherSavedPlaceInput): Promise<SavedPlacesView> {
    const owner = new Types.ObjectId(userId);
    const label = this.cleanLabel(input.label);
    const count = await this.saved.countDocuments({ userId: owner, kind: SavedPlaceKind.OTHER });
    if (count >= MAX_OTHER_SAVED_PLACES)
      throw apiBadRequest(
        `You can save up to ${MAX_OTHER_SAVED_PLACES} places. Remove one to add another.`,
        "SAVED_PLACE_LIMIT_REACHED",
        { limit: MAX_OTHER_SAVED_PLACES },
      );
    const name = input.name?.trim();
    try {
      await this.saved.create({
        userId: owner,
        kind: SavedPlaceKind.OTHER,
        label,
        labelKey: labelKey(label),
        address: clampAddress(input.address),
        latitude: input.latitude,
        longitude: input.longitude,
        ...(name ? { name } : {}),
      });
    } catch (error) {
      if (isDuplicateKey(error)) throw this.duplicateLabel(label);
      throw error;
    }
    return this.forUser(userId);
  }

  /** Renames and/or moves an "other" place; only the fields sent change. */
  async updateOther(userId: string, id: string, input: Partial<OtherSavedPlaceInput>): Promise<SavedPlacesView> {
    const set: Record<string, unknown> = {};
    const unset: Record<string, 1> = {};
    if (input.label !== undefined) {
      const label = this.cleanLabel(input.label);
      set.label = label;
      set.labelKey = labelKey(label);
    }
    if (input.address !== undefined) set.address = clampAddress(input.address);
    if (input.latitude !== undefined) set.latitude = input.latitude;
    if (input.longitude !== undefined) set.longitude = input.longitude;
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (name) set.name = name;
      else unset.name = 1;
    }
    try {
      const result = await this.saved.updateOne(this.otherFilter(userId, id), {
        ...(Object.keys(set).length ? { $set: set } : {}),
        ...(Object.keys(unset).length ? { $unset: unset } : {}),
      });
      if (result.matchedCount === 0) throw this.notFound();
    } catch (error) {
      if (isDuplicateKey(error)) throw this.duplicateLabel(String(set.label));
      throw error;
    }
    return this.forUser(userId);
  }

  async removeOther(userId: string, id: string): Promise<SavedPlacesView> {
    const result = await this.saved.deleteOne(this.otherFilter(userId, id));
    if (result.deletedCount === 0) throw this.notFound();
    return this.forUser(userId);
  }

  private otherFilter(userId: string, id: string) {
    if (!Types.ObjectId.isValid(id)) throw this.notFound();
    return { _id: new Types.ObjectId(id), userId: new Types.ObjectId(userId), kind: SavedPlaceKind.OTHER };
  }

  private cleanLabel(value: string): string {
    const label = value.trim().replace(/\s+/g, " ");
    if (RESERVED_LABELS.has(label.toLowerCase()))
      throw apiBadRequest(
        `Use the ${label.toLowerCase() === "home" ? "Home" : "Work"} shortcut for this address.`,
        "SAVED_PLACE_DUPLICATE_LABEL",
      );
    return label;
  }

  private duplicateLabel(label: string) {
    return apiConflict(`You already have a saved place called "${label}".`, "SAVED_PLACE_DUPLICATE_LABEL");
  }

  private notFound() {
    return apiNotFound("This saved place no longer exists", "SAVED_PLACE_NOT_FOUND");
  }
}

const toView = (row: SavedPlace & { _id: Types.ObjectId }): SavedPlaceView => ({
  id: row._id.toHexString(),
  kind: row.kind,
  label: row.label ?? null,
  name: row.name ?? null,
  address: row.address,
  latitude: row.latitude,
  longitude: row.longitude,
  updatedAt: row.updatedAt,
});
