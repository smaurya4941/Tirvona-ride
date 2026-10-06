import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Types } from "mongoose";
import type { Model } from "mongoose";
import {
  apiBadRequest,
  apiNotFound,
} from "../../common/exceptions/api.exception";
import { probeImage } from "../branding/image-probe";
import { StorageService } from "../storage/storage.service";
import type { ImageInfo } from "../branding/image-probe";
import { ProfileImage } from "./schemas/profile-image.schema";
import { User } from "./schemas/user.schema";

/**
 * The apps crop the photo to a square and scale it to at most 1024 px
 * before uploading, so real uploads are ~100–300 KB; the limits only keep
 * out what could not be a profile photo.
 */
export const PROFILE_IMAGE_RULE = {
  maxBytes: 5 * 1024 * 1024,
  minSide: 128,
  maxSide: 4096,
  /** height ÷ width — anything from a tall portrait to a wide landscape crop. */
  minAspect: 0.5,
  maxAspect: 2,
  hint: "PNG, JPEG or WEBP, at least 128 × 128 px, up to 5 MB",
} as const;

export interface ProfileImageContent {
  body: Readable | Buffer;
  length: number;
  contentType: string;
  version: string;
}

/** Why the upload cannot be a profile photo, or null if it can. */
export function profileImageProblem(
  bytes: number,
  image: ImageInfo | null,
): string | null {
  const rule = PROFILE_IMAGE_RULE;
  if (!image) return "Photo must be a PNG, JPEG or WEBP image";
  if (bytes > rule.maxBytes) return "Photo must be at most 5 MB";
  if (image.width < rule.minSide || image.height < rule.minSide)
    return `Photo must be at least ${rule.minSide} × ${rule.minSide} px (got ${image.width} × ${image.height})`;
  if (image.width > rule.maxSide || image.height > rule.maxSide)
    return `Photo must be at most ${rule.maxSide} × ${rule.maxSide} px (got ${image.width} × ${image.height})`;
  const aspect = image.height / image.width;
  if (aspect < rule.minAspect || aspect > rule.maxAspect)
    return `Photo is too narrow or too wide (got ${image.width} × ${image.height})`;
  return null;
}

export const profileImagePath = (version: string): string =>
  `/users/me/profile-image?v=${version}`;

/**
 * Profile photos: validated by their bytes (never the declared type) and
 * stored through StorageService (GridFS). `profile_images` keeps only the
 * metadata and the file reference; rows from before GridFS still hold the
 * bytes inline (`data`) and keep working until the storage migration moves them.
 */
@Injectable()
export class ProfileImagesService {
  constructor(
    @InjectModel(ProfileImage.name)
    private readonly images: Model<ProfileImage>,
    @InjectModel(User.name) private readonly users: Model<User>,
    private readonly storage: StorageService,
  ) {}

  /** Replaces the user's photo; returns the new app path. */
  async replace(userId: string, upload: { buffer: Buffer }): Promise<string> {
    const image = probeImage(upload.buffer);
    const problem = profileImageProblem(upload.buffer.length, image);
    if (problem || !image)
      throw apiBadRequest(problem ?? "Unsupported image", "PROFILE_IMAGE_INVALID", { hint: PROFILE_IMAGE_RULE.hint });

    const owner = new Types.ObjectId(userId);
    const version = createHash("sha256").update(upload.buffer).digest("hex").slice(0, 16);
    const fileRef = await this.storage.put(upload, { segment: "profile-images", ownerId: userId, allow: ["image"] });
    let previous: { fileRef?: string } | null;
    try {
      previous = await this.images
        .findOneAndUpdate(
          { userId: owner },
          {
            $set: {
              contentType: image.contentType,
              fileRef,
              bytes: upload.buffer.length,
              width: image.width,
              height: image.height,
              version,
            },
            $unset: { data: 1 },
          },
          { upsert: true, returnDocument: "before" },
        )
        .select("fileRef")
        .lean()
        .exec();
    } catch (error) {
      // The new copy is not referenced by anything: do not leave it behind.
      await this.storage.remove(fileRef);
      throw error;
    }
    // Only after the new photo is in place; a failed delete is just an orphan.
    if (previous?.fileRef && previous.fileRef !== fileRef) await this.storage.remove(previous.fileRef);

    const path = profileImagePath(version);
    await this.users.updateOne({ _id: owner }, { $set: { profileImage: path } }).exec();
    return path;
  }

  async remove(userId: string): Promise<void> {
    const owner = new Types.ObjectId(userId);
    const removed = await this.images.findOneAndDelete({ userId: owner }).select("fileRef").lean().exec();
    await this.storage.remove(removed?.fileRef);
    await this.users.updateOne({ _id: owner }, { $unset: { profileImage: 1 } }).exec();
  }

  /** The cache key and type, without touching the bytes (for the 304 check). */
  async describe(userId: string): Promise<{ contentType: string; version: string }> {
    const image = await this.images
      .findOne({ userId: new Types.ObjectId(userId) })
      .select("contentType version")
      .lean()
      .exec();
    if (!image) throw apiNotFound("You haven't added a profile photo", "PROFILE_IMAGE_NOT_SET");
    return { contentType: image.contentType, version: image.version };
  }

  /** The photo itself, as a response body. */
  async content(userId: string): Promise<ProfileImageContent> {
    const image = await this.images
      .findOne({ userId: new Types.ObjectId(userId) })
      .select("+data fileRef contentType version")
      .lean()
      .exec();
    if (!image) throw apiNotFound("You haven't added a profile photo", "PROFILE_IMAGE_NOT_SET");
    if (image.fileRef) {
      const object = await this.storage.open(image.fileRef);
      return { body: object.stream, length: object.length, contentType: image.contentType, version: image.version };
    }
    if (!image.data) throw apiNotFound("You haven't added a profile photo", "PROFILE_IMAGE_NOT_SET");
    const data = Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength);
    return { body: data, length: data.length, contentType: image.contentType, version: image.version };
  }
}
