import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, Types } from "mongoose";
import type { HydratedDocument } from "mongoose";
import { CommissionConfigStatus, CommissionType } from "../interfaces/earning-status";

/**
 * Commission history. Each admin change is a new version — nothing is ever
 * overwritten — so "what rate applied on 20 Sep?" always has an answer.
 * The rate in force at time T is the ACTIVE version with the latest
 * `effectiveFrom ≤ T`.
 */
@Schema({ timestamps: true, collection: "commission_configs" })
export class CommissionConfig {
  @Prop({ required: true, min: 1 })
  version!: number;

  @Prop({ required: true, enum: CommissionType, default: CommissionType.PERCENTAGE })
  type!: CommissionType;

  /** Percent of the gross fare (0–100, up to two decimals). */
  @Prop({ required: true, min: 0, max: 100 })
  value!: number;

  @Prop({ required: true })
  effectiveFrom!: Date;

  @Prop({ required: true, enum: CommissionConfigStatus, default: CommissionConfigStatus.ACTIVE })
  status!: CommissionConfigStatus;

  @Prop({ trim: true })
  note?: string;

  /** Absent for the version seeded from DEFAULT_COMMISSION_PERCENT. */
  @Prop({ type: SchemaTypes.ObjectId, ref: "User" })
  createdBy?: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: "User" })
  cancelledBy?: Types.ObjectId;

  @Prop()
  cancelledAt?: Date;
}

export type CommissionConfigDocument = HydratedDocument<CommissionConfig>;
export const CommissionConfigSchema = SchemaFactory.createForClass(CommissionConfig);

CommissionConfigSchema.index({ version: 1 }, { unique: true });
CommissionConfigSchema.index({ status: 1, effectiveFrom: -1, version: -1 });
