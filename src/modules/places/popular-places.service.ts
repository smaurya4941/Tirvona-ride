import { createHash } from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";
import type { OnApplicationBootstrap } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectModel } from "@nestjs/mongoose";
import { Types } from "mongoose";
import type { Model } from "mongoose";
import { apiBadRequest, apiNotFound } from "../../common/exceptions/api.exception";
import { probeImage } from "../branding/image-probe";
import type { ImageInfo } from "../branding/image-probe";
import type { GeoCoordinates } from "../locations/geo";
import { fromGeoJsonPoint, haversineMeters, toGeoJsonPoint } from "../locations/geo";
import { bookingAddress } from "./place-text";
import type { PlaceSuggestion } from "./places.types";
import { POPULAR_PLACE_SEEDS } from "./popular-places.seed";
import { PopularPlace } from "./schemas/popular-place.schema";

export const POPULAR_PLACE_ID_PREFIX = "popular:";

/** What the apps can show well as a 16:10-ish card thumbnail. */
export const POPULAR_IMAGE_RULE = {
  maxBytes: 1024 * 1024,
  minWidth: 320,
  minHeight: 200,
  /** height ÷ width */
  minAspect: 0.4,
  maxAspect: 1.1,
  hint: "Landscape PNG, JPEG or WEBP, at least 320 × 200 px (800 × 500 recommended), up to 1 MB",
} as const;

export interface PopularPlaceInput {
  name: string;
  secondaryText: string;
  city: string;
  latitude: number;
  longitude: number;
  active?: boolean;
  sortOrder?: number;
}

export interface PopularPlaceAdminView {
  id: string;
  name: string;
  secondaryText: string;
  city: string;
  latitude: number;
  longitude: number;
  active: boolean;
  sortOrder: number;
  /** Relative to the versioned API base; null when no photo is set. */
  imagePath: string | null;
  image: { width: number; height: number; bytes: number } | null;
  updatedAt: Date;
}

export interface PopularPlaceImageFile {
  data: Buffer;
  contentType: string;
  version: string;
}

type PlaceRow = Pick<PopularPlace, "name" | "secondaryText" | "city" | "location" | "active" | "sortOrder" | "updatedAt"> & {
  _id: Types.ObjectId;
  image?: { version: string; width: number; height: number; bytes: number };
};

const LIST_PROJECTION = "name secondaryText city location active sortOrder updatedAt image.version image.width image.height image.bytes";

/**
 * "Popular destinations": admin-curated places with an optional photo,
 * stored in MongoDB. Riders get the active ones near them, nearest first.
 */
@Injectable()
export class PopularPlacesService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PopularPlacesService.name);
  private readonly radiusMeters: number;

  constructor(
    @InjectModel(PopularPlace.name) private readonly places: Model<PopularPlace>,
    config: ConfigService,
  ) {
    this.radiusMeters = config.getOrThrow<number>("placesFeaturedRadiusKm") * 1000;
  }

  /** First boot only: an admin who deletes a seeded place keeps it deleted. */
  async onApplicationBootstrap(): Promise<void> {
    try {
      if (await this.places.exists({})) return;
      await this.places.insertMany(
        POPULAR_PLACE_SEEDS.map((seed) => ({
          name: seed.name,
          secondaryText: seed.secondaryText,
          city: seed.city,
          location: toGeoJsonPoint(seed),
          active: true,
          sortOrder: seed.sortOrder,
        })),
      );
      this.logger.log(`Seeded ${POPULAR_PLACE_SEEDS.length} popular places`);
    } catch (error) {
      // Another instance seeding at the same moment, or the DB is briefly
      // unreachable: popular places are optional, never block startup.
      this.logger.warn(`Popular places not seeded: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Active places within the popular radius of the rider, nearest first; with
   * no position, every active place in admin order. A rider far from every
   * place gets an empty list (the apps then hide the section).
   */
  async forRider(near: GeoCoordinates | undefined, limit: number): Promise<PlaceSuggestion[]> {
    const rows = near
      ? await this.places
          .find({
            active: true,
            location: { $nearSphere: { $geometry: toGeoJsonPoint(near), $maxDistance: this.radiusMeters } },
          })
          .select(LIST_PROJECTION)
          .limit(limit)
          .lean<PlaceRow[]>()
      : await this.places.find({ active: true }).select(LIST_PROJECTION).sort({ sortOrder: 1, name: 1 }).limit(limit).lean<PlaceRow[]>();
    return rows.map((row) => toSuggestion(row, near));
  }

  async list(): Promise<PopularPlaceAdminView[]> {
    const rows = await this.places.find().select(LIST_PROJECTION).sort({ city: 1, sortOrder: 1, name: 1 }).lean<PlaceRow[]>();
    return rows.map(toAdminView);
  }

  async create(input: PopularPlaceInput, adminId: string): Promise<PopularPlaceAdminView> {
    const created = await this.places.create({
      name: input.name,
      secondaryText: input.secondaryText,
      city: input.city,
      location: toGeoJsonPoint(input),
      active: input.active ?? true,
      sortOrder: input.sortOrder ?? 100,
      updatedBy: new Types.ObjectId(adminId),
    });
    return this.view(created._id);
  }

  async update(id: string, input: Partial<PopularPlaceInput>, adminId: string): Promise<PopularPlaceAdminView> {
    const current = await this.places.findById(id).select("location").lean();
    if (!current) throw notFound();
    const point = fromGeoJsonPoint(current.location);
    const latitude = input.latitude ?? point.latitude;
    const longitude = input.longitude ?? point.longitude;
    await this.places.updateOne(
      { _id: id },
      {
        $set: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.secondaryText !== undefined ? { secondaryText: input.secondaryText } : {}),
          ...(input.city !== undefined ? { city: input.city } : {}),
          ...(input.active !== undefined ? { active: input.active } : {}),
          ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
          location: toGeoJsonPoint({ latitude, longitude }),
          updatedBy: new Types.ObjectId(adminId),
        },
      },
      { runValidators: true },
    );
    return this.view(id);
  }

  /** Returns the deleted place's name, for the audit log. */
  async remove(id: string): Promise<string> {
    const deleted = await this.places.findByIdAndDelete(id).select("name").lean();
    if (!deleted) throw notFound();
    return deleted.name;
  }

  /** Validates the photo by its bytes and replaces the current one. */
  async setImage(id: string, upload: { buffer: Buffer }, adminId: string): Promise<PopularPlaceAdminView> {
    const image = probeImage(upload.buffer);
    const problem = imageProblem(upload.buffer.length, image);
    if (problem || !image) throw apiBadRequest(problem ?? "Unsupported image", "POPULAR_PLACE_INVALID_IMAGE", { hint: POPULAR_IMAGE_RULE.hint });
    const result = await this.places.updateOne(
      { _id: id },
      {
        $set: {
          image: {
            contentType: image.contentType,
            data: upload.buffer,
            bytes: upload.buffer.length,
            width: image.width,
            height: image.height,
            version: createHash("sha256").update(upload.buffer).digest("hex").slice(0, 16),
          },
          updatedBy: new Types.ObjectId(adminId),
        },
      },
    );
    if (result.matchedCount === 0) throw notFound();
    return this.view(id);
  }

  async removeImage(id: string, adminId: string): Promise<PopularPlaceAdminView> {
    const result = await this.places.updateOne({ _id: id }, { $unset: { image: 1 }, $set: { updatedBy: new Types.ObjectId(adminId) } });
    if (result.matchedCount === 0) throw notFound();
    return this.view(id);
  }

  async imageFile(id: string): Promise<PopularPlaceImageFile> {
    // Hydrated, not lean: lean returns a BSON Binary instead of a Buffer.
    const place = Types.ObjectId.isValid(id) ? await this.places.findById(id).select("+image.data") : null;
    if (!place?.image) throw apiNotFound("This place has no photo", "POPULAR_PLACE_IMAGE_NOT_SET");
    return { data: place.image.data, contentType: place.image.contentType, version: place.image.version };
  }

  private async view(id: Types.ObjectId | string): Promise<PopularPlaceAdminView> {
    const row = await this.places.findById(id).select(LIST_PROJECTION).lean<PlaceRow>();
    if (!row) throw notFound();
    return toAdminView(row);
  }
}

const notFound = () => apiNotFound("Popular place not found", "POPULAR_PLACE_NOT_FOUND");

const imagePath = (row: PlaceRow): string | null =>
  row.image ? `/places/popular/${row._id.toHexString()}/image?v=${row.image.version}` : null;

function toSuggestion(row: PlaceRow, near: GeoCoordinates | undefined): PlaceSuggestion {
  const point = fromGeoJsonPoint(row.location);
  return {
    id: `${POPULAR_PLACE_ID_PREFIX}${row._id.toHexString()}`,
    name: row.name,
    secondaryText: row.secondaryText,
    address: bookingAddress(row.name, row.secondaryText),
    latitude: point.latitude,
    longitude: point.longitude,
    ...(near ? { distanceMeters: Math.round(haversineMeters(near, point)) } : {}),
    featured: true,
    imagePath: imagePath(row),
  };
}

function toAdminView(row: PlaceRow): PopularPlaceAdminView {
  const point = fromGeoJsonPoint(row.location);
  return {
    id: row._id.toHexString(),
    name: row.name,
    secondaryText: row.secondaryText,
    city: row.city,
    latitude: point.latitude,
    longitude: point.longitude,
    active: row.active,
    sortOrder: row.sortOrder,
    imagePath: imagePath(row),
    image: row.image ? { width: row.image.width, height: row.image.height, bytes: row.image.bytes } : null,
    updatedAt: row.updatedAt,
  };
}

/** Why the upload cannot be a place photo, or null if it can. */
export function imageProblem(bytes: number, image: ImageInfo | null): string | null {
  const rule = POPULAR_IMAGE_RULE;
  if (!image) return "Photo must be a PNG, JPEG or WEBP image";
  if (bytes > rule.maxBytes) return "Photo must be at most 1 MB";
  if (image.width < rule.minWidth || image.height < rule.minHeight)
    return `Photo must be at least ${rule.minWidth} × ${rule.minHeight} px (got ${image.width} × ${image.height})`;
  const aspect = image.height / image.width;
  if (aspect < rule.minAspect || aspect > rule.maxAspect)
    return `Photo must be landscape (height about 0.4–1.1 × width, got ${image.width} × ${image.height})`;
  return null;
}
