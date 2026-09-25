import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, Types } from "mongoose";
import type { HydratedDocument } from "mongoose";

/**
 * People to reach when a user triggers SOS. Profile-owned: only the user
 * can list or change them; the SOS incident keeps a snapshot for the
 * safety team.
 */
@Schema({ timestamps: true, collection: "emergency_contacts" })
export class EmergencyContact {
  @Prop({ required: true, type: SchemaTypes.ObjectId, ref: "User" })
  userId!: Types.ObjectId;

  @Prop({ required: true, trim: true, maxlength: 80 })
  name!: string;

  /** E.164. */
  @Prop({ required: true, trim: true })
  phone!: string;

  @Prop({ trim: true, maxlength: 40 })
  relationship?: string;

  @Prop({ required: true, default: false })
  isPrimary!: boolean;

  createdAt!: Date;
  updatedAt!: Date;
}

export type EmergencyContactDocument = HydratedDocument<EmergencyContact>;
export const EmergencyContactSchema = SchemaFactory.createForClass(EmergencyContact);

EmergencyContactSchema.index({ userId: 1, createdAt: 1 });
// The same number twice is a typo, not a second contact.
EmergencyContactSchema.index({ userId: 1, phone: 1 }, { unique: true });
// At most one primary contact per user, enforced by the database.
EmergencyContactSchema.index(
  { userId: 1 },
  { unique: true, partialFilterExpression: { isPrimary: true }, name: "uniq_primary_emergency_contact" },
);
