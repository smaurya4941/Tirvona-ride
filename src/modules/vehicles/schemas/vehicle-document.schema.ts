import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, Types } from "mongoose";
import type { HydratedDocument } from "mongoose";
import { DocumentStatus } from "../../../common/types/document-status.enum";

export enum VehicleDocumentType {
  RC = "RC",
  INSURANCE = "INSURANCE",
  PERMIT = "PERMIT",
  POLLUTION_CERTIFICATE = "POLLUTION_CERTIFICATE",
}

@Schema({ timestamps: true, collection: "vehicle_documents" })
export class VehicleDocument {
  @Prop({ required: true, type: SchemaTypes.ObjectId, ref: "Vehicle" })
  vehicleId!: Types.ObjectId;

  @Prop({ required: true, enum: VehicleDocumentType })
  documentType!: VehicleDocumentType;

  @Prop()
  documentNumber?: string;

  @Prop({ required: true })
  filePath!: string;

  @Prop({ required: true, enum: DocumentStatus, default: DocumentStatus.PENDING })
  status!: DocumentStatus;

  @Prop()
  expiryDate?: Date;

  @Prop({ type: SchemaTypes.ObjectId, ref: "User" })
  verifiedBy?: Types.ObjectId;

  @Prop()
  verifiedAt?: Date;
}

export type VehicleDocumentDocument = HydratedDocument<VehicleDocument>;
export const VehicleDocumentSchema = SchemaFactory.createForClass(VehicleDocument);

VehicleDocumentSchema.index({ vehicleId: 1, documentType: 1 });
