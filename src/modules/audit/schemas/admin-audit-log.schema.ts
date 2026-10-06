import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, Types } from "mongoose";
import type { HydratedDocument } from "mongoose";

/**
 * Every high-impact admin action: who did what to which record, when and
 * why. Append-only — nothing in the API updates or deletes these rows.
 */
@Schema({
  timestamps: { createdAt: true, updatedAt: false },
  collection: "admin_audit_logs",
})
export class AdminAuditLog {
  @Prop({
    required: true,
    type: SchemaTypes.ObjectId,
    ref: "User",
    immutable: true,
  })
  adminId!: Types.ObjectId;

  /** Dotted verb, e.g. "driver.suspend", "promo.deactivate", "broadcast.send". */
  @Prop({ required: true, immutable: true })
  action!: string;

  /** DRIVER | CUSTOMER | RIDE | RIDE_TYPE | ZONE | PROMO | … */
  @Prop({ required: true, immutable: true })
  targetType!: string;

  @Prop({ required: true, immutable: true })
  targetId!: string;

  /** Human label shown in the log (ride code, promo code, driver name). */
  @Prop({ immutable: true })
  targetLabel?: string;

  @Prop({ trim: true, immutable: true })
  reason?: string;

  @Prop({ type: SchemaTypes.Mixed, immutable: true })
  metadata?: Record<string, unknown>;

  createdAt?: Date;
}

export type AdminAuditLogDocument = HydratedDocument<AdminAuditLog>;
export const AdminAuditLogSchema = SchemaFactory.createForClass(AdminAuditLog);

AdminAuditLogSchema.index({ createdAt: -1 });
AdminAuditLogSchema.index({ targetType: 1, targetId: 1, createdAt: -1 });
AdminAuditLogSchema.index({ adminId: 1, createdAt: -1 });
AdminAuditLogSchema.index({ action: 1, createdAt: -1 });
