import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, Types } from "mongoose";
import type { HydratedDocument } from "mongoose";
import { UserRole } from "../../../common/types/user-role.enum";
import { ComplaintCategory, ComplaintPriority, ComplaintStatus } from "../complaint-rules";

@Schema({ _id: false })
export class TicketHistoryEntry {
  @Prop({ required: true })
  at!: Date;

  @Prop({ type: SchemaTypes.ObjectId, ref: "User" })
  byUserId?: Types.ObjectId;

  @Prop({ required: true, enum: UserRole })
  byRole!: UserRole;

  @Prop({ required: true })
  action!: string;

  @Prop({ enum: ComplaintStatus })
  status?: ComplaintStatus;

  @Prop({ trim: true, maxlength: 2000 })
  note?: string;
}
const TicketHistoryEntrySchema = SchemaFactory.createForClass(TicketHistoryEntry);

/** A customer or driver complaint, optionally about one ride. */
@Schema({ timestamps: true, collection: "support_tickets" })
export class SupportTicket {
  /** Quoted to support ("TKT-4HX8QW"). */
  @Prop({ required: true })
  ticketCode!: string;

  @Prop({ required: true, type: SchemaTypes.ObjectId, ref: "User" })
  userId!: Types.ObjectId;

  @Prop({ required: true, enum: [UserRole.CUSTOMER, UserRole.DRIVER] })
  userRole!: UserRole;

  @Prop({ type: SchemaTypes.ObjectId, ref: "Ride" })
  rideId?: Types.ObjectId;

  @Prop()
  rideCode?: string;

  /** The ride's other party, snapshotted (who the complaint may be about). */
  @Prop({ type: SchemaTypes.ObjectId, ref: "User" })
  customerId?: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: "DriverProfile" })
  driverId?: Types.ObjectId;

  @Prop({ required: true, enum: ComplaintCategory })
  category!: ComplaintCategory;

  @Prop({ required: true, trim: true, maxlength: 120 })
  subject!: string;

  @Prop({ required: true, trim: true, maxlength: 2000 })
  description!: string;

  @Prop({ required: true, enum: ComplaintStatus, default: ComplaintStatus.OPEN })
  status!: ComplaintStatus;

  @Prop({ required: true, enum: ComplaintPriority, default: ComplaintPriority.MEDIUM })
  priority!: ComplaintPriority;

  @Prop({ type: SchemaTypes.ObjectId, ref: "User" })
  assignedAdminId?: Types.ObjectId;

  /** Shown to the user once resolved. */
  @Prop({ trim: true, maxlength: 2000 })
  resolution?: string;

  @Prop()
  resolvedAt?: Date;

  @Prop()
  closedAt?: Date;

  @Prop({ type: [TicketHistoryEntrySchema], default: [] })
  history!: TicketHistoryEntry[];

  createdAt!: Date;
  updatedAt!: Date;
}

export type SupportTicketDocument = HydratedDocument<SupportTicket>;
export const SupportTicketSchema = SchemaFactory.createForClass(SupportTicket);

SupportTicketSchema.index({ ticketCode: 1 }, { unique: true });
SupportTicketSchema.index({ userId: 1, createdAt: -1 });
SupportTicketSchema.index({ rideId: 1, createdAt: -1 });
SupportTicketSchema.index({ status: 1, priority: 1, createdAt: -1 });
SupportTicketSchema.index({ createdAt: -1 });
