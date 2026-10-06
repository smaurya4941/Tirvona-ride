import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectConnection } from "@nestjs/mongoose";
import { mongo } from "mongoose";
import type { Connection } from "mongoose";
import { apiNotFound } from "../../common/exceptions/api.exception";
import type { StorageObject, StoragePutInput, StorageProvider } from "./storage-provider";

/** 255 KiB, MongoDB's default: a 5 MB document is ~20 chunks. */
const CHUNK_SIZE_BYTES = 255 * 1024;

/**
 * Files in MongoDB GridFS (`<bucket>.files` / `<bucket>.chunks`) on the same
 * Atlas cluster as everything else, so nothing depends on the web server's
 * disk (Render's filesystem is wiped on every deploy) and backups, access
 * control and restores stay in one place.
 *
 * Uses the driver bundled with Mongoose (`mongoose.mongo`) so its types always
 * match the connection.
 */
@Injectable()
export class GridFsStorageProvider implements StorageProvider {
  readonly scheme = "gridfs";
  private readonly logger = new Logger(GridFsStorageProvider.name);
  private readonly bucketName: string;
  private cached?: mongo.GridFSBucket;

  constructor(
    @InjectConnection() private readonly connection: Connection,
    config: ConfigService,
  ) {
    this.bucketName = config.getOrThrow<string>("storageGridfsBucket");
  }

  /** Created on first use: the connection is guaranteed up by then. */
  private get bucket(): mongo.GridFSBucket {
    if (!this.cached) {
      const db = this.connection.db;
      if (!db) throw new ServiceUnavailableException({ message: "File storage is not ready", code: "STORAGE_UNAVAILABLE" });
      this.cached = new mongo.GridFSBucket(db, { bucketName: this.bucketName, chunkSizeBytes: CHUNK_SIZE_BYTES });
    }
    return this.cached;
  }

  async put(input: StoragePutInput): Promise<string> {
    // The driver has no top-level contentType any more; it lives in metadata.
    const upload = this.bucket.openUploadStream(input.filename, {
      metadata: { ...input.metadata, contentType: input.contentType },
    });
    try {
      await pipeline(Readable.from([input.buffer]), upload);
    } catch (error) {
      // A half-written upload leaves orphan chunks; remove what was started.
      await this.bucket.delete(upload.id).catch(() => undefined);
      this.logger.error(`GridFS upload failed: ${error instanceof Error ? error.message : String(error)}`);
      throw new ServiceUnavailableException({
        message: "We could not save the file. Please try again.",
        code: "STORAGE_UNAVAILABLE",
      });
    }
    return upload.id.toHexString();
  }

  async open(key: string): Promise<StorageObject> {
    const id = this.objectId(key);
    const [file] = await this.bucket.find({ _id: id }, { limit: 1 }).toArray();
    if (!file) throw apiNotFound("The document file is missing", "DOCUMENT_NOT_FOUND");
    return {
      stream: this.bucket.openDownloadStream(id),
      contentType: typeof file.metadata?.contentType === "string" ? file.metadata.contentType : "application/octet-stream",
      length: file.length,
      filename: file.filename,
    };
  }

  async delete(key: string): Promise<void> {
    try {
      await this.bucket.delete(this.objectId(key));
    } catch (error) {
      // FileNotFound: already gone.
      if (error instanceof Error && /FileNotFound/i.test(`${error.name} ${error.message}`)) return;
      throw error;
    }
  }

  private objectId(key: string): mongo.ObjectId {
    if (!/^[0-9a-f]{24}$/i.test(key)) throw apiNotFound("The document file is missing", "DOCUMENT_NOT_FOUND");
    return new mongo.ObjectId(key);
  }
}
