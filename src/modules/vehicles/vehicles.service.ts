import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import type { Model } from "mongoose";
import { apiConflict, apiNotFound } from "../../common/exceptions/api.exception";
import { removeFile, storeUpload } from "../../common/http/file-upload";
import { DocumentStatus } from "../../common/types/document-status.enum";
import { DriversService } from "../drivers/drivers.service";
import { CreateVehicleDto } from "./dto/create-vehicle.dto";
import { UpdateVehicleDto } from "./dto/update-vehicle.dto";
import { UploadVehicleDocumentDto } from "./dto/upload-vehicle-document.dto";
import {
  VehicleDocument as VehicleDocumentModel,
} from "./schemas/vehicle-document.schema";
import type { VehicleDocumentDocument } from "./schemas/vehicle-document.schema";
import { Vehicle } from "./schemas/vehicle.schema";
import type { VehicleDocument } from "./schemas/vehicle.schema";

export interface VehicleSummary {
  id: string;
  vehicleType: string;
  registrationNumber: string;
  make?: string;
  model?: string;
  color?: string;
  manufactureYear?: number;
  vehicleImage?: string;
  isActive: boolean;
}

@Injectable()
export class VehiclesService {
  constructor(
    @InjectModel(Vehicle.name) private readonly vehicleModel: Model<Vehicle>,
    @InjectModel(VehicleDocumentModel.name)
    private readonly documentModel: Model<VehicleDocumentModel>,
    private readonly drivers: DriversService,
  ) {}

  toSummary(vehicle: VehicleDocument): VehicleSummary {
    return {
      id: vehicle._id.toString(),
      vehicleType: vehicle.vehicleType,
      registrationNumber: vehicle.registrationNumber,
      make: vehicle.make,
      model: vehicle.vehicleModel,
      color: vehicle.color,
      manufactureYear: vehicle.manufactureYear,
      vehicleImage: vehicle.vehicleImage,
      isActive: vehicle.isActive,
    };
  }

  async create(userId: string, dto: CreateVehicleDto): Promise<VehicleDocument> {
    const driver = await this.drivers.getByUserId(userId);
    this.drivers.assertEditable(driver);

    const registrationNumber = dto.registrationNumber.toUpperCase();
    if (await this.vehicleModel.exists({ registrationNumber }))
      throw apiConflict(
        "A vehicle with this registration number already exists",
        "VEHICLE_ALREADY_EXISTS",
      );

    return this.vehicleModel.create({
      driverId: driver._id,
      vehicleType: dto.vehicleType,
      registrationNumber,
      make: dto.make,
      vehicleModel: dto.model,
      color: dto.color,
      manufactureYear: dto.manufactureYear,
      isActive: true,
    });
  }

  async findMine(userId: string): Promise<VehicleDocument[]> {
    const driver = await this.drivers.getByUserId(userId);
    return this.vehicleModel.find({ driverId: driver._id }).sort({ createdAt: -1 }).exec();
  }

  async findOneOwned(userId: string, vehicleId: string): Promise<VehicleDocument> {
    const driver = await this.drivers.getByUserId(userId);
    return this.ownedVehicle(driver._id.toString(), vehicleId);
  }

  /** Ownership check plus the onboarding lock — for every mutation. */
  private async findOwnedForEdit(
    userId: string,
    vehicleId: string,
  ): Promise<VehicleDocument> {
    const driver = await this.drivers.getByUserId(userId);
    this.drivers.assertEditable(driver);
    return this.ownedVehicle(driver._id.toString(), vehicleId);
  }

  private async ownedVehicle(
    driverId: string,
    vehicleId: string,
  ): Promise<VehicleDocument> {
    const vehicle = await this.vehicleModel
      .findOne({ _id: vehicleId, driverId })
      .exec();
    // 404 regardless of "missing" vs "belongs to another driver" — never
    // confirms another driver's vehicle exists (spec §37, Test E).
    if (!vehicle) throw apiNotFound("Vehicle not found", "VEHICLE_NOT_FOUND");
    return vehicle;
  }

  async listByDriverId(driverId: string): Promise<VehicleDocument[]> {
    return this.vehicleModel.find({ driverId }).sort({ createdAt: -1 }).exec();
  }

  async update(
    userId: string,
    vehicleId: string,
    dto: UpdateVehicleDto,
  ): Promise<VehicleDocument> {
    const vehicle = await this.findOwnedForEdit(userId, vehicleId);

    if (dto.registrationNumber !== undefined) {
      const registrationNumber = dto.registrationNumber.toUpperCase();
      if (
        registrationNumber !== vehicle.registrationNumber &&
        (await this.vehicleModel.exists({ registrationNumber }))
      )
        throw apiConflict(
          "A vehicle with this registration number already exists",
          "VEHICLE_ALREADY_EXISTS",
        );
      vehicle.registrationNumber = registrationNumber;
    }
    if (dto.vehicleType !== undefined) vehicle.vehicleType = dto.vehicleType;
    if (dto.make !== undefined) vehicle.make = dto.make;
    if (dto.model !== undefined) vehicle.vehicleModel = dto.model;
    if (dto.color !== undefined) vehicle.color = dto.color;
    if (dto.manufactureYear !== undefined)
      vehicle.manufactureYear = dto.manufactureYear;
    await vehicle.save();
    return vehicle;
  }

  async deactivate(userId: string, vehicleId: string): Promise<void> {
    const vehicle = await this.findOwnedForEdit(userId, vehicleId);
    vehicle.isActive = false;
    await vehicle.save();
  }

  async addDocument(
    userId: string,
    vehicleId: string,
    dto: UploadVehicleDocumentDto,
    file: Express.Multer.File,
  ): Promise<VehicleDocumentDocument> {
    const vehicle = await this.findOwnedForEdit(userId, vehicleId);

    const filePath = await storeUpload(file, "vehicles", vehicle._id.toString());
    try {
      const existing = await this.documentModel
        .findOne({ vehicleId: vehicle._id, documentType: dto.documentType })
        .exec();
      if (existing) {
        const previousPath = existing.filePath;
        existing.filePath = filePath;
        existing.documentNumber = dto.documentNumber;
        existing.status = DocumentStatus.PENDING;
        existing.verifiedBy = undefined;
        existing.verifiedAt = undefined;
        await existing.save();
        await removeFile(previousPath);
        return existing;
      }

      return await this.documentModel.create({
        vehicleId: vehicle._id,
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

  async listDocuments(
    userId: string,
    vehicleId: string,
  ): Promise<VehicleDocumentDocument[]> {
    const vehicle = await this.findOneOwned(userId, vehicleId);
    return this.documentModel.find({ vehicleId: vehicle._id }).exec();
  }

  async listDocumentsByVehicleId(
    vehicleId: string,
  ): Promise<VehicleDocumentDocument[]> {
    return this.documentModel.find({ vehicleId }).exec();
  }

  async getDocumentForOwner(
    userId: string,
    vehicleId: string,
    documentId: string,
  ): Promise<VehicleDocumentDocument> {
    const vehicle = await this.findOneOwned(userId, vehicleId);
    const document = await this.documentModel
      .findOne({ _id: documentId, vehicleId: vehicle._id })
      .exec();
    if (!document)
      throw apiNotFound("Document not found", "DOCUMENT_NOT_FOUND");
    return document;
  }

  async getDocumentById(documentId: string): Promise<VehicleDocumentDocument> {
    const document = await this.documentModel.findById(documentId).exec();
    if (!document)
      throw apiNotFound("Document not found", "DOCUMENT_NOT_FOUND");
    return document;
  }
}
