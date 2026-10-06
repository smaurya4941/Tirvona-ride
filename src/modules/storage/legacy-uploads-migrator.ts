import { Injectable, Logger } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import type { Model } from "mongoose";
import { DriverChangeRequest } from "../driver-changes/schemas/driver-change-request.schema";
import { DriverDocument } from "../drivers/schemas/driver-document.schema";
import { ProfileImage } from "../users/schemas/profile-image.schema";
import { VehicleDocument } from "../vehicles/schemas/vehicle-document.schema";
import { detectFile } from "./document-content";
import { LegacyDiskStorage } from "./legacy-disk-storage";
import { StorageService } from "./storage.service";
import type { StorageSegment } from "./storage.service";

export interface MigrationReport {
  scanned: number;
  migrated: number;
  /** The file is no longer on disk (e.g. wiped by a redeploy): re-upload needed. */
  missing: number;
  /** Not a JPEG/PNG/WEBP/PDF, or lost a race with an edit. */
  skipped: number;
}

interface Target {
  label: string;
  model: Model<{ filePath?: string }>;
  segment: StorageSegment;
}

/**
 * Moves documents saved on the server's disk (before GridFS) into the active
 * storage provider and rewrites their reference. Safe to run repeatedly and
 * while the API is serving: each row is updated only if it still holds the
 * path that was copied, and the disk file is deleted only after that.
 */
@Injectable()
export class LegacyUploadsMigrator {
  private readonly logger = new Logger(LegacyUploadsMigrator.name);
  private readonly targets: Target[];

  constructor(
    @InjectModel(DriverDocument.name) driverDocuments: Model<DriverDocument>,
    @InjectModel(VehicleDocument.name) vehicleDocuments: Model<VehicleDocument>,
    @InjectModel(DriverChangeRequest.name) changeRequests: Model<DriverChangeRequest>,
    @InjectModel(ProfileImage.name) private readonly profileImages: Model<ProfileImage>,
    private readonly storage: StorageService,
    private readonly legacy: LegacyDiskStorage,
  ) {
    this.targets = [
      { label: "driver_documents", model: driverDocuments as unknown as Target["model"], segment: "drivers" },
      { label: "vehicle_documents", model: vehicleDocuments as unknown as Target["model"], segment: "vehicles" },
      { label: "driver_change_requests", model: changeRequests as unknown as Target["model"], segment: "driver-changes" },
    ];
  }

  async run(options: { dryRun?: boolean } = {}): Promise<MigrationReport> {
    const report: MigrationReport = { scanned: 0, migrated: 0, missing: 0, skipped: 0 };
    for (const target of this.targets) {
      const rows = await target.model
        .find({ filePath: { $exists: true, $nin: [null, ""] } })
        .select("+filePath")
        .lean()
        .exec();
      for (const row of rows as Array<{ _id: unknown; filePath?: string }>) {
        const path = row.filePath;
        if (!path || this.storage.isManaged(path)) continue;
        report.scanned += 1;
        try {
          await this.migrateOne(target, row._id, path, options.dryRun === true, report);
        } catch (error) {
          report.skipped += 1;
          this.logger.warn(`${target.label} ${String(row._id)}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    await this.migrateProfileImages(options.dryRun === true, report);
    return report;
  }

  /** Photos stored inline in `profile_images.data` move to file storage too. */
  private async migrateProfileImages(dryRun: boolean, report: MigrationReport): Promise<void> {
    const rows = await this.profileImages
      .find({ fileRef: { $exists: false }, data: { $exists: true } })
      .select("+data userId")
      .lean()
      .exec();
    for (const row of rows) {
      report.scanned += 1;
      try {
        const buffer = Buffer.from(row.data!.buffer, row.data!.byteOffset, row.data!.byteLength);
        if (dryRun) {
          report.migrated += 1;
          continue;
        }
        const reference = await this.storage.put(
          { buffer },
          { segment: "profile-images", ownerId: String(row.userId), allow: ["image"] },
        );
        const updated = await this.profileImages
          .updateOne({ _id: row._id, fileRef: { $exists: false } }, { $set: { fileRef: reference }, $unset: { data: 1 } })
          .exec();
        if (updated.modifiedCount === 1) report.migrated += 1;
        else {
          await this.storage.remove(reference);
          report.skipped += 1;
        }
      } catch (error) {
        report.skipped += 1;
        this.logger.warn(`profile_images ${String(row._id)}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private async migrateOne(target: Target, id: unknown, path: string, dryRun: boolean, report: MigrationReport): Promise<void> {
    let object;
    try {
      object = await this.legacy.open(path);
    } catch {
      report.missing += 1;
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of object.stream) chunks.push(Buffer.from(chunk as Buffer));
    const buffer = Buffer.concat(chunks);
    if (!detectFile(buffer)) {
      report.skipped += 1;
      return;
    }
    if (dryRun) {
      report.migrated += 1;
      return;
    }
    const reference = await this.storage.put(
      { buffer, originalname: object.filename },
      { segment: target.segment, ownerId: String(id) },
    );
    const updated = await target.model.updateOne({ _id: id, filePath: path }, { $set: { filePath: reference } }).exec();
    if (updated.modifiedCount === 1) {
      await this.legacy.delete(path);
      report.migrated += 1;
    } else {
      // The row changed while copying: drop the copy, the next run retries.
      await this.storage.remove(reference);
      report.skipped += 1;
    }
  }
}
