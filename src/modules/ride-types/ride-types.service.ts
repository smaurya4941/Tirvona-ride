import { Injectable, Logger } from "@nestjs/common";
import type { OnModuleInit } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import type { Model } from "mongoose";
import { apiBadRequest, apiNotFound } from "../../common/exceptions/api.exception";
import type { VehicleType } from "../vehicles/schemas/vehicle.schema";
import type { UpdateRideTypeDto } from "./dto/update-ride-type.dto";
import { DEFAULT_RIDE_TYPES } from "./ride-types.seed";
import { RideType, RideTypeCode } from "./schemas/ride-type.schema";
import type { RideTypeDocument } from "./schemas/ride-type.schema";

export interface RideTypeSummary {
  id: string;
  code: RideTypeCode;
  displayName: string;
  description?: string;
  icon: string;
  vehicleType: VehicleType;
  seatCapacity: number;
  sortOrder: number;
  isActive: boolean;
  updatedAt: Date;
}

const isDuplicateKey = (error: unknown): boolean =>
  (error as { code?: number } | undefined)?.code === 11000;

@Injectable()
export class RideTypesService implements OnModuleInit {
  private readonly logger = new Logger(RideTypesService.name);

  constructor(@InjectModel(RideType.name) private readonly rideTypeModel: Model<RideType>) {}

  async onModuleInit(): Promise<void> {
    await this.seedDefaults();
  }

  /** Idempotent and safe to run concurrently from several instances. */
  async seedDefaults(): Promise<void> {
    for (const rideType of DEFAULT_RIDE_TYPES) {
      try {
        const result = await this.rideTypeModel
          .updateOne({ code: rideType.code }, { $setOnInsert: rideType }, { upsert: true })
          .exec();
        if (result.upsertedCount > 0) this.logger.log(`Seeded ride type ${rideType.code}`);
      } catch (error) {
        // Another instance won the upsert race; the row exists either way.
        if (!isDuplicateKey(error)) throw error;
      }
    }
  }

  toSummary(rideType: RideTypeDocument): RideTypeSummary {
    return {
      id: rideType._id.toString(),
      code: rideType.code,
      displayName: rideType.displayName,
      description: rideType.description,
      icon: rideType.icon,
      vehicleType: rideType.vehicleType,
      seatCapacity: rideType.seatCapacity,
      sortOrder: rideType.sortOrder,
      isActive: rideType.isActive,
      updatedAt: rideType.get("updatedAt") as Date,
    };
  }

  async listActive(): Promise<RideTypeDocument[]> {
    return this.rideTypeModel.find({ isActive: true }).sort({ sortOrder: 1 }).exec();
  }

  async listAll(): Promise<RideTypeDocument[]> {
    return this.rideTypeModel.find().sort({ sortOrder: 1 }).exec();
  }

  async getByCode(code: RideTypeCode): Promise<RideTypeDocument> {
    const rideType = await this.rideTypeModel.findOne({ code }).exec();
    if (!rideType) throw apiNotFound("Ride type not found", "RIDE_TYPE_NOT_FOUND");
    return rideType;
  }

  /** For booking: the ride type must exist and be switched on. */
  async getBookable(code: RideTypeCode): Promise<RideTypeDocument> {
    const rideType = await this.getByCode(code);
    if (!rideType.isActive)
      throw apiBadRequest(
        `${rideType.displayName} rides are not available right now`,
        "RIDE_TYPE_INACTIVE",
      );
    return rideType;
  }

  async update(code: RideTypeCode, dto: UpdateRideTypeDto): Promise<RideTypeDocument> {
    const rideType = await this.getByCode(code);
    if (dto.displayName !== undefined) rideType.displayName = dto.displayName;
    if (dto.description !== undefined) rideType.description = dto.description;
    if (dto.isActive !== undefined) rideType.isActive = dto.isActive;
    if (dto.sortOrder !== undefined) rideType.sortOrder = dto.sortOrder;
    await rideType.save();
    return rideType;
  }
}
