import { Injectable, Logger } from "@nestjs/common";
import type { OnModuleInit } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import type { Model } from "mongoose";
import { Types } from "mongoose";
import { apiBadRequest, apiConflict, apiNotFound } from "../../common/exceptions/api.exception";
import { RideTypeCode } from "../ride-types/schemas/ride-type.schema";
import type { UpdatePricingDto } from "./dto/update-pricing.dto";
import { calculateFare } from "./fare-calculator";
import { PeakPricingService } from "./peak-pricing.service";
import { peakRates } from "./peak-pricing";
import type { AppliedPeak } from "./peak-pricing";
import type { FareBreakdown, PricingRates } from "./fare-calculator";
import { PricingConfig } from "./schemas/pricing-config.schema";
import type { PricingConfigDocument } from "./schemas/pricing-config.schema";

export interface PricingSummary extends PricingRates {
  id: string;
  rideType: string;
  version: number;
  updatedAt: Date;
}

export interface PricedFare extends FareBreakdown {
  pricingVersion: number;
  /**
   * The permanent per-km rate. `perKmRate` (inherited) is what the trip is
   * charged at: equal to this normally, higher while a peak slot is in force.
   */
  basePerKmRate: number;
  /** The peak that raised the per-km rate; absent at normal pricing. */
  peak?: AppliedPeak;
}

// Launch tariffs — seeded once, then owned by admins through the panel.
// E_RICKSHAW deliberately has none: its tariff is a business decision that
// an admin enters before activating the ride type.
const DEFAULT_PRICING: Partial<Record<RideTypeCode, Omit<PricingRates, "currency">>> = {
  [RideTypeCode.BIKE]: { baseFare: 20, perKmRate: 6, perMinuteRate: 1, minimumFare: 30 },
  [RideTypeCode.AUTO]: { baseFare: 30, perKmRate: 10, perMinuteRate: 1.5, minimumFare: 40 },
  [RideTypeCode.CAB]: { baseFare: 50, perKmRate: 14, perMinuteRate: 2, minimumFare: 80 },
};

const isDuplicateKey = (error: unknown): boolean =>
  (error as { code?: number } | undefined)?.code === 11000;

@Injectable()
export class PricingService implements OnModuleInit {
  private readonly logger = new Logger(PricingService.name);

  constructor(
    @InjectModel(PricingConfig.name) private readonly pricingModel: Model<PricingConfig>,
    private readonly peaks: PeakPricingService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.seedDefaults();
  }

  async seedDefaults(): Promise<void> {
    for (const [rideType, rates] of Object.entries(DEFAULT_PRICING) as Array<
      [RideTypeCode, Omit<PricingRates, "currency">]
    >) {
      try {
        const result = await this.pricingModel
          .updateOne(
            { rideType },
            { $setOnInsert: { rideType, currency: "INR", version: 1, ...rates } },
            { upsert: true },
          )
          .exec();
        if (result.upsertedCount > 0) this.logger.log(`Seeded pricing for ${rideType}`);
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
      }
    }
  }

  toSummary(config: PricingConfigDocument): PricingSummary {
    return {
      id: config._id.toString(),
      rideType: config.rideType,
      currency: config.currency,
      baseFare: config.baseFare,
      perKmRate: config.perKmRate,
      perMinuteRate: config.perMinuteRate,
      minimumFare: config.minimumFare,
      version: config.version,
      updatedAt: config.get("updatedAt") as Date,
    };
  }

  async listAll(): Promise<PricingConfigDocument[]> {
    return this.pricingModel.find().sort({ rideType: 1 }).exec();
  }

  async findConfig(rideType: string): Promise<PricingConfigDocument | null> {
    return this.pricingModel.findOne({ rideType }).exec();
  }

  async getConfig(rideType: string): Promise<PricingConfigDocument> {
    const config = await this.pricingModel.findOne({ rideType }).exec();
    if (!config)
      throw apiNotFound(`Pricing is not configured for ${rideType}`, "PRICING_NOT_CONFIGURED");
    return config;
  }

  /**
   * Prices a trip with the tariff that is active right now: the ride type's
   * base tariff, with the per-km rate raised by the peak slot in force at
   * `at` (the server clock; never a device's). Base fare, per-minute rate and
   * minimum fare are never touched by a peak.
   */
  async priceTrip(
    rideType: string,
    distanceMeters: number,
    durationSeconds: number,
    at: Date = new Date(),
  ): Promise<PricedFare> {
    const config = await this.getConfig(rideType);
    const slot = await this.peaks.resolve(rideType, at);
    if (!slot)
      return {
        ...calculateFare(config, distanceMeters, durationSeconds),
        pricingVersion: config.version,
        basePerKmRate: config.perKmRate,
      };

    // Plain rates, not the Mongoose document: spreading a hydrated document loses its fields.
    const base: PricingRates = {
      currency: config.currency,
      baseFare: config.baseFare,
      perKmRate: config.perKmRate,
      perMinuteRate: config.perMinuteRate,
      minimumFare: config.minimumFare,
    };
    const fare = calculateFare(peakRates(base, slot.hikePercent), distanceMeters, durationSeconds);
    const normalDistanceCharge = calculateFare(base, distanceMeters, durationSeconds).distanceCharge;
    return {
      ...fare,
      pricingVersion: config.version,
      basePerKmRate: config.perKmRate,
      peak: {
        slotId: slot.id,
        name: slot.name,
        hikePercent: slot.hikePercent,
        startTime: slot.startTime,
        endTime: slot.endTime,
        surcharge: Math.round((fare.distanceCharge - normalDistanceCharge) * 100) / 100,
      },
    };
  }

  /** First tariff of a new ride type (every rate required). */
  async create(
    rideType: string,
    rates: Omit<PricingRates, "currency">,
    adminUserId: string,
  ): Promise<PricingConfigDocument> {
    try {
      return await this.pricingModel.create({
        rideType,
        currency: "INR",
        version: 1,
        baseFare: rates.baseFare,
        perKmRate: rates.perKmRate,
        perMinuteRate: rates.perMinuteRate,
        minimumFare: rates.minimumFare,
        updatedBy: new Types.ObjectId(adminUserId),
      });
    } catch (error) {
      if (isDuplicateKey(error))
        throw apiConflict(`A tariff for ${rideType} already exists`, "VALIDATION_FAILED");
      throw error;
    }
  }

  async update(
    rideType: string,
    dto: UpdatePricingDto,
    adminUserId: string,
  ): Promise<PricingConfigDocument> {
    const changes = Object.fromEntries(
      Object.entries(dto).filter(([, value]) => value !== undefined),
    );
    if (Object.keys(changes).length === 0)
      throw apiBadRequest("Provide at least one pricing field to change", "VALIDATION_FAILED");

    // Atomic: concurrent admin saves each bump the version exactly once.
    const config = await this.pricingModel
      .findOneAndUpdate(
        { rideType },
        {
          $set: { ...changes, updatedBy: new Types.ObjectId(adminUserId) },
          $inc: { version: 1 },
        },
        { returnDocument: "after", runValidators: true },
      )
      .exec();
    if (!config)
      throw apiNotFound(`Pricing is not configured for ${rideType}`, "PRICING_NOT_CONFIGURED");
    this.logger.log(`Pricing for ${rideType} updated to v${config.version} by ${adminUserId}`);
    return config;
  }
}
