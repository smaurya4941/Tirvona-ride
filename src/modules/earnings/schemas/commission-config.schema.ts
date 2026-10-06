import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, Types } from "mongoose";
import type { HydratedDocument } from "mongoose";
import { RIDE_TYPE_CODE_PATTERN } from "../../ride-types/schemas/ride-type.schema";
import {
  CommissionConfigStatus,
  CommissionType,
} from "../interfaces/earning-status";

/**
 * Commission history, one version sequence per ride type. Each admin change
 * is a new version — nothing is ever overwritten — so "what rate applied to
 * a Cab on 20 Sep?" always has an answer. The rate in force for a ride type
 * at time T is its ACTIVE version with the latest `effectiveFrom ≤ T`.
 *
 * Rows without `rideType` are the single global rates from before commission
 * became per ride type. They are kept untouched because earlier earnings
 * point at them (`commissionConfigId`); the resolver ignores them, and each
 * ride type received a copy of that history at migration.
 */
@Schema({ timestamps: true, collection: "commission_configs" })
export class CommissionConfig {
  /** The ride type this rate belongs to (RideType.code). Absent on legacy global rows. */
  @Prop({ match: RIDE_TYPE_CODE_PATTERN })
  rideType?: string;

  /** Counts up per ride type: Bike v3, Auto v2, Cab v5. */
  @Prop({ required: true, min: 1 })
  version!: number;

  @Prop({
    required: true,
    enum: CommissionType,
    default: CommissionType.PERCENTAGE,
  })
  type!: CommissionType;

  /** Percent of the final fare (0–100, up to two decimals). */
  @Prop({ required: true, min: 0, max: 100 })
  value!: number;

  @Prop({ required: true })
  effectiveFrom!: Date;

  @Prop({
    required: true,
    enum: CommissionConfigStatus,
    default: CommissionConfigStatus.ACTIVE,
  })
  status!: CommissionConfigStatus;

  @Prop({ trim: true })
  note?: string;

  /** Absent for versions seeded from DEFAULT_COMMISSION_PERCENT. */
  @Prop({ type: SchemaTypes.ObjectId, ref: "User" })
  createdBy?: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: "User" })
  cancelledBy?: Types.ObjectId;

  @Prop()
  cancelledAt?: Date;
}

export type CommissionConfigDocument = HydratedDocument<CommissionConfig>;
export const CommissionConfigSchema =
  SchemaFactory.createForClass(CommissionConfig);

// Version numbers are unique within a ride type (legacy rows have none).
CommissionConfigSchema.index(
  { rideType: 1, version: 1 },
  {
    unique: true,
    partialFilterExpression: { rideType: { $exists: true } },
    name: "uniq_commission_version_per_ride_type",
  },
);
// Two live versions of one ride type may not start at the same instant:
// which one applied would be ambiguous.
CommissionConfigSchema.index(
  { rideType: 1, effectiveFrom: 1 },
  {
    unique: true,
    partialFilterExpression: {
      rideType: { $exists: true },
      status: CommissionConfigStatus.ACTIVE,
    },
    name: "uniq_active_commission_start_per_ride_type",
  },
);
// The resolver: newest applicable version for a ride type.
CommissionConfigSchema.index({
  rideType: 1,
  status: 1,
  effectiveFrom: -1,
  version: -1,
});
