import { randomBytes } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import type { Model } from "mongoose";
import { Types } from "mongoose";
import {
  apiBadRequest,
  apiConflict,
  apiNotFound,
} from "../../common/exceptions/api.exception";
import { removeFile, storeUpload } from "../../common/http/file-upload";
import { DocumentStatus } from "../../common/types/document-status.enum";
import { Vehicle } from "../vehicles/schemas/vehicle.schema";
import { UpdateDriverProfileDto } from "./dto/update-driver-profile.dto";
import { UploadDriverDocumentDto } from "./dto/upload-driver-document.dto";
import {
  DriverDocument,
  DriverDocumentType,
} from "./schemas/driver-document.schema";
import type { DriverDocumentDocument } from "./schemas/driver-document.schema";
import { DriverProfile, DriverStatus } from "./schemas/driver-profile.schema";
import type { DriverProfileDocument } from "./schemas/driver-profile.schema";

export interface DriverSummary {
  id: string;
  driverCode: string;
  driverStatus: DriverStatus;
  licenseNumber?: string;
  licenseExpiry?: Date;
  dateOfBirth?: Date;
  address?: string;
  ratingAverage: number;
  ratingCount: number;
  totalRides: number;
  isOnline: boolean;
  isAvailable: boolean;
  approvedAt?: Date;
  rejectionReason?: string;
}

// Documents a driver must have on file (any status) before KYC can be
// submitted for admin review. Business rule, not part of the schema itself.
const REQUIRED_DOCUMENT_TYPES: DriverDocumentType[] = [
  DriverDocumentType.DRIVING_LICENSE,
  DriverDocumentType.AADHAAR,
  DriverDocumentType.PROFILE_PHOTO,
];

// Submitting KYC locks the application so the admin never reviews a moving
// target; it unlocks again only if the admin rejects it. Changes after
// approval would need re-verification, which is out of Phase 1 scope.
const EDITABLE_STATUSES: DriverStatus[] = [
  DriverStatus.PENDING,
  DriverStatus.REJECTED,
];

@Injectable()
export class DriversService {
  constructor(
    @InjectModel(DriverProfile.name)
    private readonly driverModel: Model<DriverProfile>,
    @InjectModel(DriverDocument.name)
    private readonly documentModel: Model<DriverDocument>,
    @InjectModel(Vehicle.name)
    private readonly vehicleModel: Model<Vehicle>,
  ) {}

  toSummary(driver: DriverProfileDocument): DriverSummary {
    return {
      id: driver._id.toString(),
      driverCode: driver.driverCode,
      driverStatus: driver.driverStatus,
      licenseNumber: driver.licenseNumber,
      licenseExpiry: driver.licenseExpiry,
      dateOfBirth: driver.dateOfBirth,
      address: driver.address,
      ratingAverage: driver.ratingAverage,
      ratingCount: driver.ratingCount ?? 0,
      totalRides: driver.totalRides,
      isOnline: driver.isOnline,
      isAvailable: driver.isAvailable,
      approvedAt: driver.approvedAt,
      rejectionReason: driver.rejectionReason,
    };
  }

  async createProfileForUser(userId: string): Promise<DriverProfileDocument> {
    return this.driverModel.create({
      userId: new Types.ObjectId(userId),
      driverCode: await this.generateUniqueDriverCode(),
      driverStatus: DriverStatus.PENDING,
    });
  }

  async findByUserId(userId: string): Promise<DriverProfileDocument | null> {
    return this.driverModel.findOne({ userId: new Types.ObjectId(userId) }).exec();
  }

  async getByUserId(userId: string): Promise<DriverProfileDocument> {
    const driver = await this.findByUserId(userId);
    if (!driver) throw apiNotFound("Driver profile not found", "DRIVER_NOT_FOUND");
    return driver;
  }

  async getById(driverId: string): Promise<DriverProfileDocument> {
    const driver = await this.driverModel.findById(driverId).exec();
    if (!driver) throw apiNotFound("Driver profile not found", "DRIVER_NOT_FOUND");
    return driver;
  }

  async updateProfile(
    userId: string,
    dto: UpdateDriverProfileDto,
  ): Promise<DriverProfileDocument> {
    const driver = await this.getByUserId(userId);
    this.assertEditable(driver);

    if (dto.licenseNumber !== undefined) driver.licenseNumber = dto.licenseNumber;
    if (dto.licenseExpiry !== undefined)
      driver.licenseExpiry = new Date(dto.licenseExpiry);
    if (dto.dateOfBirth !== undefined)
      driver.dateOfBirth = new Date(dto.dateOfBirth);
    if (dto.address !== undefined) driver.address = dto.address;
    await driver.save();
    return driver;
  }

  async addDocument(
    userId: string,
    dto: UploadDriverDocumentDto,
    file: Express.Multer.File,
  ): Promise<DriverDocumentDocument> {
    const driver = await this.getByUserId(userId);
    this.assertEditable(driver);

    const filePath = await storeUpload(file, "drivers", driver._id.toString());
    try {
      // Resubmitting a document type replaces the previous file+record
      // rather than accumulating duplicates.
      const existing = await this.documentModel
        .findOne({ driverId: driver._id, documentType: dto.documentType })
        .exec();
      if (existing) {
        const previousPath = existing.filePath;
        existing.filePath = filePath;
        existing.documentNumber = dto.documentNumber;
        existing.status = DocumentStatus.PENDING;
        existing.rejectionReason = undefined;
        existing.verifiedBy = undefined;
        existing.verifiedAt = undefined;
        await existing.save();
        await removeFile(previousPath);
        return existing;
      }

      return await this.documentModel.create({
        driverId: driver._id,
        documentType: dto.documentType,
        documentNumber: dto.documentNumber,
        filePath,
        status: DocumentStatus.PENDING,
      });
    } catch (error) {
      await removeFile(filePath);
      throw error;
    }
  }

  async listDocuments(userId: string): Promise<DriverDocumentDocument[]> {
    const driver = await this.getByUserId(userId);
    return this.documentModel.find({ driverId: driver._id }).exec();
  }

  async deleteDocument(userId: string, documentId: string): Promise<void> {
    const driver = await this.getByUserId(userId);
    const document = await this.documentModel
      .findOne({ _id: documentId, driverId: driver._id })
      .exec();
    if (!document)
      throw apiNotFound("Document not found", "DOCUMENT_NOT_FOUND");

    this.assertEditable(driver);
    if (document.status !== DocumentStatus.PENDING)
      throw apiBadRequest(
        "Only a pending document can be removed",
        "DOCUMENT_NOT_EDITABLE",
      );

    await document.deleteOne();
    await removeFile(document.filePath);
  }

  async getDocumentForOwner(
    userId: string,
    documentId: string,
  ): Promise<DriverDocumentDocument> {
    const driver = await this.getByUserId(userId);
    return this.getDocumentOfDriver(driver._id.toString(), documentId);
  }

  async getDocumentOfDriver(
    driverId: string,
    documentId: string,
  ): Promise<DriverDocumentDocument> {
    const document = await this.documentModel
      .findOne({ _id: documentId, driverId })
      .exec();
    if (!document)
      throw apiNotFound("Document not found", "DOCUMENT_NOT_FOUND");
    return document;
  }

  async submitKyc(userId: string): Promise<DriverProfileDocument> {
    const driver = await this.getByUserId(userId);

    if (
      driver.driverStatus === DriverStatus.UNDER_REVIEW ||
      driver.driverStatus === DriverStatus.APPROVED
    )
      throw apiConflict(
        "KYC has already been submitted for review",
        "DRIVER_ALREADY_SUBMITTED",
      );
    if (driver.driverStatus === DriverStatus.SUSPENDED)
      throw apiBadRequest(
        "This driver account is suspended",
        "INVALID_DRIVER_STATUS",
      );

    const [documents, hasVehicle] = await Promise.all([
      this.documentModel.find({ driverId: driver._id }).exec(),
      this.vehicleModel.exists({ driverId: driver._id, isActive: true }),
    ]);
    const uploadedTypes = new Set(documents.map((doc) => doc.documentType));
    const missing = REQUIRED_DOCUMENT_TYPES.filter(
      (type) => !uploadedTypes.has(type),
    );
    if (!driver.licenseNumber || !driver.licenseExpiry || missing.length > 0 || !hasVehicle)
      throw apiBadRequest(
        "Complete your license details, vehicle and required documents before submitting",
        "DRIVER_KYC_INCOMPLETE",
        {
          missingDocuments: missing,
          missingLicense: !driver.licenseNumber || !driver.licenseExpiry,
          missingVehicle: !hasVehicle,
        },
      );

    driver.driverStatus = DriverStatus.UNDER_REVIEW;
    driver.rejectionReason = undefined;
    await driver.save();
    return driver;
  }

  async listForAdmin(status?: DriverStatus): Promise<DriverProfileDocument[]> {
    const filter = status ? { driverStatus: status } : {};
    return this.driverModel.find(filter).sort({ createdAt: -1 }).exec();
  }

  async countByStatus(): Promise<Record<DriverStatus, number>> {
    const counts = await this.driverModel
      .aggregate<{ _id: DriverStatus; count: number }>([
        { $group: { _id: "$driverStatus", count: { $sum: 1 } } },
      ])
      .exec();
    const result = Object.fromEntries(
      Object.values(DriverStatus).map((status) => [status, 0]),
    ) as Record<DriverStatus, number>;
    for (const entry of counts) result[entry._id] = entry.count;
    return result;
  }

  async approve(driverId: string, adminUserId: string): Promise<DriverProfileDocument> {
    const driver = await this.getById(driverId);
    if (driver.driverStatus !== DriverStatus.UNDER_REVIEW)
      throw apiBadRequest(
        `Cannot approve a driver in ${driver.driverStatus} status`,
        "INVALID_STATUS_TRANSITION",
      );

    driver.driverStatus = DriverStatus.APPROVED;
    driver.approvedAt = new Date();
    driver.approvedBy = new Types.ObjectId(adminUserId);
    driver.rejectionReason = undefined;
    await driver.save();
    return driver;
  }

  async reject(
    driverId: string,
    reason: string,
  ): Promise<DriverProfileDocument> {
    const driver = await this.getById(driverId);
    if (driver.driverStatus !== DriverStatus.UNDER_REVIEW)
      throw apiBadRequest(
        `Cannot reject a driver in ${driver.driverStatus} status`,
        "INVALID_STATUS_TRANSITION",
      );

    driver.driverStatus = DriverStatus.REJECTED;
    driver.rejectionReason = reason;
    await driver.save();
    return driver;
  }

  /** Throws unless the driver's onboarding data may still change. */
  assertEditable(driver: DriverProfileDocument): void {
    if (!EDITABLE_STATUSES.includes(driver.driverStatus))
      throw apiBadRequest(
        `Driver details cannot be changed while ${driver.driverStatus}`,
        "INVALID_DRIVER_STATUS",
      );
  }

  private async generateUniqueDriverCode(): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = `DR${Date.now().toString(36).toUpperCase()}${randomBytes(2)
        .toString("hex")
        .toUpperCase()}`;
      if (!(await this.driverModel.exists({ driverCode: code }))) return code;
    }
    throw new Error("Failed to generate a unique driver code");
  }
}
