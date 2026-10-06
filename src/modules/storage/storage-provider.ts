import type { Readable } from "node:stream";

/** What a provider needs to store one file. The key it returns is opaque to callers. */
export interface StoragePutInput {
  buffer: Buffer;
  /** Server-generated name (never user input). */
  filename: string;
  contentType: string;
  /** Searchable tags kept next to the file: module, owner, original name, hash. */
  metadata: Record<string, string>;
}

export interface StorageObject {
  stream: Readable;
  contentType: string;
  length: number;
  filename: string;
}

/**
 * One place files can live. {@link StorageService} owns the references that
 * are saved in documents (`<scheme>:<key>`) and routes to the provider whose
 * `scheme` matches. A provider never sees another provider's keys, so adding
 * Cloudinary later is one new class plus one entry in the module: no schema,
 * controller or Flutter change.
 */
export interface StorageProvider {
  /** Prefix of the references this provider issues, e.g. "gridfs". */
  readonly scheme: string;
  put(input: StoragePutInput): Promise<string>;
  /** Throws a 404 ApiException when the object is gone. */
  open(key: string): Promise<StorageObject>;
  /** Idempotent: deleting a missing object is not an error. */
  delete(key: string): Promise<void>;
}
