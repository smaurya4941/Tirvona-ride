import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, Types } from "mongoose";
import type { HydratedDocument } from "mongoose";

/**
 * A manual settlement recorded by an admin (bank transfer / UPI done outside
 * the platform). V1 moves no money itself; this is the audit record of who
 * marked which earnings paid, when, and against which bank reference.
 */
@Schema({ timestamps: true, collection: "driver_payouts" })
export class DriverPayout {
  @Prop({ required: true, type: SchemaTypes.ObjectId, ref: "DriverProfile" })
  driverId!: Types.ObjectId;

  /** The earnings this payout actually settled. */
  @Prop({ type: [SchemaTypes.ObjectId], ref: "DriverEarning", default: [] })
  earningIds!: Types.ObjectId[];

  @Prop({ required: true, default: 0 })
  earningCount!: number;

  @Prop({ required: true, min: 0, default: 0 })
  amountPaise!: number;

  @Prop({ required: true, default: "INR" })
  currency!: string;

  @Prop({ required: true, trim: true })
  payoutReference!: string;

  @Prop({ trim: true })
  note?: string;

  @Prop({ required: true, type: SchemaTypes.ObjectId, ref: "User" })
  paidBy!: Types.ObjectId;

  @Prop({ required: true })
  paidAt!: Date;
}

export type DriverPayoutDocument = HydratedDocument<DriverPayout>;
export const DriverPayoutSchema = SchemaFactory.createForClass(DriverPayout);

DriverPayoutSchema.index({ driverId: 1, paidAt: -1 });
