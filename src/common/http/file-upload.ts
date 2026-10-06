import { extname } from "node:path";
import type { MulterModuleOptions } from "@nestjs/platform-express";
import { memoryStorage } from "multer";
import { apiBadRequest } from "../exceptions/api.exception";

const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);
const ALLOWED_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".pdf"]);
export const MAX_DOCUMENT_SIZE_BYTES = 5 * 1024 * 1024;

/**
 * First, cheap gate on the declared type. The authoritative check is on the
 * bytes, in StorageService#put (a renamed file passes this one, not that one).
 */
export const documentFileFilter: NonNullable<MulterModuleOptions["fileFilter"]> = (_request, file, callback): void => {
  const extension = extname(file.originalname).toLowerCase();
  if (!ALLOWED_MIME_TYPES.has(file.mimetype) || !ALLOWED_EXTENSIONS.has(extension)) {
    callback(apiBadRequest("Only JPEG, PNG, WEBP or PDF files are accepted", "DOCUMENT_INVALID_TYPE"), false);
    return;
  }
  callback(null, true);
};

/**
 * Uploads stay in memory (5 MB, one file) and go straight to StorageService:
 * nothing is written to the web server's disk, which does not survive a deploy.
 */
export const documentUploadOptions: MulterModuleOptions = {
  storage: memoryStorage(),
  fileFilter: documentFileFilter,
  limits: { fileSize: MAX_DOCUMENT_SIZE_BYTES, files: 1 },
};
