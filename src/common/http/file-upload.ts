import { randomUUID } from "node:crypto";
import { createReadStream, mkdirSync } from "node:fs";
import { mkdir, rename, stat, unlink } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { StreamableFile } from "@nestjs/common";
import type { MulterModuleOptions } from "@nestjs/platform-express";
import { diskStorage } from "multer";
import { apiBadRequest, apiNotFound } from "../exceptions/api.exception";

export const UPLOAD_ROOT = join(process.cwd(), "uploads");
const UPLOAD_TMP_DIR = join(UPLOAD_ROOT, "tmp");

const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
]);
const ALLOWED_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".pdf"]);
export const MAX_DOCUMENT_SIZE_BYTES = 5 * 1024 * 1024;

const MIME_BY_EXTENSION: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
};

/**
 * Multer writes to `uploads/tmp/` first: the owning driver/vehicle id is only
 * known once the service has resolved (and authorised) it, at which point
 * {@link storeUpload} moves the file to its final folder. Filenames are
 * random — never derived from user input.
 */
export const documentStorage = diskStorage({
  destination: (_request, _file, callback) => {
    mkdirSync(UPLOAD_TMP_DIR, { recursive: true });
    callback(null, UPLOAD_TMP_DIR);
  },
  filename: (_request, file, callback) => {
    callback(null, `${randomUUID()}${extname(file.originalname).toLowerCase()}`);
  },
});

export const documentFileFilter: NonNullable<MulterModuleOptions["fileFilter"]> = (
  _request,
  file,
  callback,
): void => {
  const extension = extname(file.originalname).toLowerCase();
  if (
    !ALLOWED_MIME_TYPES.has(file.mimetype) ||
    !ALLOWED_EXTENSIONS.has(extension)
  ) {
    callback(
      apiBadRequest(
        "Only JPEG, PNG, WEBP or PDF files are accepted",
        "DOCUMENT_INVALID_TYPE",
      ),
      false,
    );
    return;
  }
  callback(null, true);
};

export const documentUploadOptions: MulterModuleOptions = {
  storage: documentStorage,
  fileFilter: documentFileFilter,
  limits: { fileSize: MAX_DOCUMENT_SIZE_BYTES, files: 1 },
};

/** Moves a temp upload to `uploads/<segment>/<ownerId>/` and returns its path. */
export async function storeUpload(
  file: Express.Multer.File,
  segment: "drivers" | "vehicles",
  ownerId: string,
): Promise<string> {
  const directory = join(UPLOAD_ROOT, segment, ownerId);
  await mkdir(directory, { recursive: true });
  const target = join(directory, basename(file.path));
  await rename(file.path, target);
  return target;
}

export async function removeFile(path: string): Promise<void> {
  await unlink(path).catch(() => undefined);
}

/** Streams a stored document inline; 404s if the file has gone from disk. */
export async function streamDocument(filePath: string): Promise<StreamableFile> {
  const exists = await stat(filePath).then(
    (info) => info.isFile(),
    () => false,
  );
  if (!exists)
    throw apiNotFound("The document file is missing", "DOCUMENT_NOT_FOUND");
  return new StreamableFile(createReadStream(filePath), {
    type:
      MIME_BY_EXTENSION[extname(filePath).toLowerCase()] ??
      "application/octet-stream",
    disposition: `inline; filename="${basename(filePath)}"`,
  });
}
