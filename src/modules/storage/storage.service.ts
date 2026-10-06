import { createHash, randomUUID } from "node:crypto";
import { Injectable, Logger, StreamableFile } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { apiBadRequest } from "../../common/exceptions/api.exception";
import { detectFile } from "./document-content";
import type { DetectedKind } from "./document-content";
import { GridFsStorageProvider } from "./gridfs-storage.provider";
import { LegacyDiskStorage } from "./legacy-disk-storage";
import type { StorageObject, StorageProvider } from "./storage-provider";

/** Which part of the product a file belongs to; stored as searchable metadata. */
export type StorageSegment = "drivers" | "vehicles" | "driver-changes" | "profile-images";

export const MAX_STORED_FILE_BYTES = 5 * 1024 * 1024;

export interface StoragePutOptions {
  segment: StorageSegment;
  /** Id of the driver / vehicle / user the file belongs to. */
  ownerId: string;
  /** Default: images and PDFs. */
  allow?: readonly DetectedKind[];
}

/** `<scheme>:<key>`; a one-letter prefix is a Windows drive ("C:\..."), not a scheme. */
const REFERENCE = /^([a-z][a-z0-9]+):(.+)$/;

/**
 * The only way the rest of the API stores, reads or deletes a file.
 *
 * Callers keep the string returned by {@link put} (the *reference*, e.g.
 * `gridfs:66f0…`) in their own document and hand it back to {@link stream} /
 * {@link remove}. They never learn where the bytes live, so switching the
 * active provider (Cloudinary later) changes only this module. References from
 * before GridFS are plain disk paths; {@link LegacyDiskStorage} still reads and
 * deletes them until `npm run storage:migrate` has moved them.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly providers: ReadonlyMap<string, StorageProvider>;
  private readonly active: StorageProvider;

  constructor(
    gridfs: GridFsStorageProvider,
    private readonly legacy: LegacyDiskStorage,
    config: ConfigService,
  ) {
    this.providers = new Map<string, StorageProvider>([[gridfs.scheme, gridfs]]);
    const name = config.getOrThrow<string>("storageProvider");
    const active = this.providers.get(name);
    if (!active) throw new Error(`STORAGE_PROVIDER "${name}" is not available`);
    this.active = active;
  }

  /**
   * Validates the bytes (not the declared type), stores them and returns the
   * reference to save. Throws 400 DOCUMENT_INVALID_TYPE / DOCUMENT_TOO_LARGE.
   */
  async put(file: { buffer: Buffer; originalname?: string }, options: StoragePutOptions): Promise<string> {
    const allow = options.allow ?? ["image", "pdf"];
    if (!file.buffer?.length) throw apiBadRequest("The file is empty", "DOCUMENT_INVALID_TYPE");
    if (file.buffer.length > MAX_STORED_FILE_BYTES)
      throw apiBadRequest("The file is larger than 5 MB", "DOCUMENT_TOO_LARGE");
    const detected = detectFile(file.buffer);
    if (!detected || !allow.includes(detected.kind))
      throw apiBadRequest(
        allow.includes("pdf") ? "Only JPEG, PNG, WEBP or PDF files are accepted" : "Only JPEG, PNG or WEBP images are accepted",
        "DOCUMENT_INVALID_TYPE",
      );

    const key = await this.active.put({
      buffer: file.buffer,
      filename: `${randomUUID()}${detected.extension}`,
      contentType: detected.contentType,
      metadata: {
        module: options.segment,
        ownerId: options.ownerId,
        originalName: (file.originalname ?? "").slice(0, 120),
        sha256: createHash("sha256").update(file.buffer).digest("hex"),
      },
    });
    return `${this.active.scheme}:${key}`;
  }

  /** Opens the stored object: 404 DOCUMENT_NOT_FOUND when it no longer exists. */
  async open(reference: string): Promise<StorageObject> {
    const match = REFERENCE.exec(reference);
    const provider = match ? this.providers.get(match[1]) : undefined;
    if (match && provider) return provider.open(match[2]);
    return this.legacy.open(reference);
  }

  /** A response body for a controller (`return this.storage.stream(doc.filePath)`). */
  async stream(reference: string): Promise<StreamableFile> {
    const object = await this.open(reference);
    return new StreamableFile(object.stream, {
      type: object.contentType,
      length: object.length,
      disposition: `inline; filename="${object.filename}"`,
    });
  }

  /**
   * Best effort and idempotent: a failure leaves an orphan file, which must
   * never fail the request that triggered the cleanup.
   */
  async remove(reference: string | undefined | null): Promise<void> {
    if (!reference) return;
    try {
      const match = REFERENCE.exec(reference);
      const provider = match ? this.providers.get(match[1]) : undefined;
      if (match && provider) await provider.delete(match[2]);
      else await this.legacy.delete(reference);
    } catch (error) {
      this.logger.warn(`Could not delete stored file ${reference}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** True for references issued by a provider (not a legacy disk path). */
  isManaged(reference: string): boolean {
    const match = REFERENCE.exec(reference);
    return Boolean(match && this.providers.has(match[1]));
  }
}
