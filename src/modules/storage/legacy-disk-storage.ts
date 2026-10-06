import { createReadStream } from "node:fs";
import { stat, unlink } from "node:fs/promises";
import { basename, extname, join, resolve, sep } from "node:path";
import { Injectable } from "@nestjs/common";
import { apiNotFound } from "../../common/exceptions/api.exception";
import type { StorageObject } from "./storage-provider";

export const LEGACY_UPLOAD_ROOT = join(process.cwd(), "uploads");

const MIME_BY_EXTENSION: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
};

/**
 * Read and delete only, for documents uploaded before GridFS, when references
 * were absolute paths under `uploads/`. New files are never written here, and
 * `npm run storage:migrate` moves the old ones into GridFS; once it reports
 * nothing left, this class and `uploads/` can be removed.
 */
@Injectable()
export class LegacyDiskStorage {
  /** The path must still be inside `uploads/`: a stored value never opens other files. */
  private safePath(path: string): string {
    const resolved = resolve(path);
    if (!resolved.startsWith(LEGACY_UPLOAD_ROOT + sep))
      throw apiNotFound("The document file is missing", "DOCUMENT_NOT_FOUND");
    return resolved;
  }

  async open(path: string): Promise<StorageObject> {
    const resolved = this.safePath(path);
    const info = await stat(resolved).catch(() => null);
    if (!info?.isFile()) throw apiNotFound("The document file is missing", "DOCUMENT_NOT_FOUND");
    return {
      stream: createReadStream(resolved),
      contentType: MIME_BY_EXTENSION[extname(resolved).toLowerCase()] ?? "application/octet-stream",
      length: info.size,
      filename: basename(resolved),
    };
  }

  async delete(path: string): Promise<void> {
    await unlink(this.safePath(path)).catch(() => undefined);
  }
}
