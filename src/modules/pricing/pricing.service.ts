import { Injectable, Logger } from "@nestjs/common";
import type { OnModuleInit } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import type { Model } from "mongoose";
import { Types } from "mongoose";
import { apiBadRequest, apiNotFound } from "../../common/exceptions/api.exception";
import { RideTypeCode } from "../ride-types/schemas/ride-type.schema";
import type { UpdatePricingDto } from "./dto/update-pricing.dto";
import { calculateFare } from "./fare-calculator";
import type { FareBreakdown, PricingRates } from "./fare-calculator";
import { PricingConfig } from "./schemas/pricing-config.schema";
import type { PricingConfigDocument } from "./schemas/pricing-config.schema";

export interface PricingSummary extends PricingRates {
  id: string;
  rideType: RideTypeCode;
  version: number;
  updatedAt: Date;
}

export interface PricedFare extends FareBreakdown {
  pricingVersion: number;
}

// Launch tariffs — seeded once, then owned by admins through the panel.
const DEFAULT_PRICING: Record<RideTypeCode, Omit<PricingRates, "currency">> = {
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
  ) {}

  async onModuleInit(): Promise<void> {
    await this.seedDefaults();
  }

  async seedDefaults(): Promise<void> {
    for (const [rideType, rates] of Object.entries(DEFAULT_PRICING) as Array<
      [RideTypeCode, (typeof DEFAULT_PRICING)[RideTypeCode]]
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
    const configs = await this.pricingModel.find().exec();
    const order = Object.values(RideTypeCode);
    return configs.sort((a, b) => order.indexOf(a.rideType) - order.indexOf(b.rideType));
  }

  async getConfig(rideType: RideTypeCode): Promise<PricingConfigDocument> {
    const config = await this.pricingModel.findOne({ rideType }).exec();
    if (!config)
      throw apiNotFound(`Pricing is not configured for ${rideType}`, "PRICING_NOT_CONFIGURED");
    return config;
  }

  /** Prices a trip with the tariff that is active right now. */
  async priceTrip(
    rideType: RideTypeCode,
    distanceMeters: number,
    durationSeconds: number,
  ): Promise<PricedFare> {
    const config = await this.getConfig(rideType);
    return {
      ...calculateFare(config, distanceMeters, durationSeconds),
      pricingVersion: config.version,
    };
  }

  async update(
    rideType: RideTypeCode,
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
