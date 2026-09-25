import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, Types } from "mongoose";
import type { HydratedDocument } from "mongoose";
import { DocumentStatus } from "../../../common/types/document-status.enum";

export enum DriverDocumentType {
  DRIVING_LICENSE = "DRIVING_LICENSE",
  AADHAAR = "AADHAAR",
  PAN = "PAN",
  PROFILE_PHOTO = "PROFILE_PHOTO",
  ADDRESS_PROOF = "ADDRESS_PROOF",
}

export { DocumentStatus };

@Schema({ timestamps: true, collection: "driver_documents" })
export class DriverDocument {
  @Prop({ required: true, type: SchemaTypes.ObjectId, ref: "DriverProfile" })
  driverId!: Types.ObjectId;

  @Prop({ required: true, enum: DriverDocumentType })
  documentType!: DriverDocumentType;

  @Prop()
  documentNumber?: string;

  @Prop({ required: true })
  filePath!: string;

  @Prop({ required: true, enum: DocumentStatus, default: DocumentStatus.PENDING })
  status!: DocumentStatus;

  @Prop()
  rejectionReason?: string;

  @Prop()
  expiryDate?: Date;

  @Prop({ type: SchemaTypes.ObjectId, ref: "User" })
  verifiedBy?: Types.ObjectId;

  @Prop()
  verifiedAt?: Date;
}

export type DriverDocumentDocument = HydratedDocument<DriverDocument>;
export const DriverDocumentSchema = SchemaFactory.createForClass(DriverDocument);

DriverDocumentSchema.index({ driverId: 1, documentType: 1 });
