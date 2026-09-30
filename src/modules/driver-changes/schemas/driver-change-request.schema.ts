import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, Types } from "mongoose";
import type { HydratedDocument } from "mongoose";

/** What an approved driver asks to change. */
export enum DriverChangeKind {
  /** Licence number / expiry, date of birth. */
  DRIVER_PROFILE = "DRIVER_PROFILE",
  /** Type, registration, make, model, colour, year of the active vehicle. */
  VEHICLE = "VEHICLE",
  /** A new or renewed KYC document (licence, Aadhaar, photo, PAN, address proof). */
  DRIVER_DOCUMENT = "DRIVER_DOCUMENT",
  /** A new or renewed vehicle document (RC, insurance, permit, PUC). */
  VEHICLE_DOCUMENT = "VEHICLE_DOCUMENT",
}

export enum DriverChangeStatus {
  PENDING = "PENDING",
  APPROVED = "APPROVED",
  REJECTED = "REJECTED",
  /** The driver took it back before review. */
  WITHDRAWN = "WITHDRAWN",
}

/**
 * A change an approved driver wants made to verified details. The live
 * profile, vehicle and documents stay exactly as verified — the driver keeps
 * driving — until an admin approves; then the change is applied atomically.
 *
 * One PENDING request per target (`targetKey`): submitting again for the
 * same target replaces the waiting request instead of queueing a second one.
 */
@Schema({ collection: "driver_change_requests", timestamps: true, versionKey: false })
export class DriverChangeRequest {
  @Prop({ required: true, type: SchemaTypes.ObjectId, ref: "DriverProfile" })
  driverId!: Types.ObjectId;

  @Prop({ required: true, type: SchemaTypes.ObjectId, ref: "User" })
  userId!: Types.ObjectId;

  @Prop({ required: true, enum: DriverChangeKind })
  kind!: DriverChangeKind;

  /**
   * What is being changed: "profile", "vehicle:<id>", "doc:<type>" or
   * "vdoc:<vehicleId>:<type>". Carries the one-pending-per-target rule.
   */
  @Prop({ required: true })
  targetKey!: string;

  @Prop({ type: SchemaTypes.ObjectId, ref: "Vehicle" })
  vehicleId?: Types.ObjectId;

  @Prop()
  documentType?: string;

  /** Requested values (field → new value). Dates are stored as Date. */
  @Prop({ type: SchemaTypes.Mixed, default: {} })
  changes!: Record<string, unknown>;

  /** The verified values at submission time, for the reviewer's diff and the audit trail. */
  @Prop({ type: SchemaTypes.Mixed, default: {} })
  previous!: Record<string, unknown>;

  /** The uploaded document (document kinds). Never returned to clients. */
  @Prop({ select: false })
  filePath?: string;

  @Prop({ required: true, enum: DriverChangeStatus, default: DriverChangeStatus.PENDING })
  status!: DriverChangeStatus;

  /** Why an admin rejected it (shown to the driver). */
  @Prop({ trim: true, maxlength: 500 })
  reviewNote?: string;

  @Prop({ type: SchemaTypes.ObjectId, ref: "User" })
  reviewedBy?: Types.ObjectId;

  @Prop()
  reviewedAt?: Date;

  createdAt!: Date;
  updatedAt!: Date;
}

export type DriverChangeRequestDocument = HydratedDocument<DriverChangeRequest>;
export const DriverChangeRequestSchema = SchemaFactory.createForClass(DriverChangeRequest);

DriverChangeRequestSchema.index(
  { driverId: 1, targetKey: 1 },
  { unique: true, partialFilterExpression: { status: DriverChangeStatus.PENDING } },
);
// The driver's history, newest first.
DriverChangeRequestSchema.index({ driverId: 1, createdAt: -1 });
// The admin review queue, oldest first.
DriverChangeRequestSchema.index({ status: 1, createdAt: 1 });
