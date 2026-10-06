import { Global, Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { DriverChangeRequest, DriverChangeRequestSchema } from "../driver-changes/schemas/driver-change-request.schema";
import { DriverDocument, DriverDocumentSchema } from "../drivers/schemas/driver-document.schema";
import { ProfileImage, ProfileImageSchema } from "../users/schemas/profile-image.schema";
import { VehicleDocument, VehicleDocumentSchema } from "../vehicles/schemas/vehicle-document.schema";
import { GridFsStorageProvider } from "./gridfs-storage.provider";
import { LegacyDiskStorage } from "./legacy-disk-storage";
import { LegacyUploadsMigrator } from "./legacy-uploads-migrator";
import { StorageService } from "./storage.service";

/**
 * File storage for the whole API (KYC documents, profile photos). Global so
 * feature modules just inject {@link StorageService}; none of them knows which
 * provider is behind it. The legacy-upload migrator lives here too because it
 * is storage plumbing, and reads other modules' collections through its own
 * model injections (no module imports, so no cycles).
 */
@Global()
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: DriverDocument.name, schema: DriverDocumentSchema },
      { name: VehicleDocument.name, schema: VehicleDocumentSchema },
      { name: DriverChangeRequest.name, schema: DriverChangeRequestSchema },
      { name: ProfileImage.name, schema: ProfileImageSchema },
    ]),
  ],
  providers: [GridFsStorageProvider, LegacyDiskStorage, StorageService, LegacyUploadsMigrator],
  exports: [StorageService, LegacyUploadsMigrator],
})
export class StorageModule {}
