import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, Types } from "mongoose";
import type { HydratedDocument } from "mongoose";
import { UserRole } from "../../../common/types/user-role.enum";

export enum UserStatus {
  ACTIVE = "ACTIVE",
  INACTIVE = "INACTIVE",
  BLOCKED = "BLOCKED",
}

@Schema({ timestamps: true, collection: "users" })
export class User {
  @Prop({ required: true, trim: true })
  phone!: string;

  @Prop({ trim: true, lowercase: true })
  email?: string;

  // select: false — never returned by default; UsersService opts in
  // explicitly (`.select('+passwordHash')`) only for login.
  @Prop({ select: false })
  passwordHash?: string;

  @Prop({ required: true, enum: UserRole })
  role!: UserRole;

  @Prop({ required: true, enum: UserStatus, default: UserStatus.ACTIVE })
  status!: UserStatus;

  @Prop({ required: true, trim: true })
  firstName!: string;

  @Prop({ trim: true })
  lastName?: string;

  /**
   * App path of the current profile photo ("/users/me/profile-image?v=…"),
   * or unset. The bytes live in profile_images (ProfileImagesService).
   */
  @Prop()
  profileImage?: string;

  @Prop()
  gender?: string;

  @Prop()
  dob?: Date;

  @Prop({ default: false })
  isPhoneVerified!: boolean;

  @Prop({ default: false })
  isEmailVerified!: boolean;

  @Prop()
  lastLoginAt?: Date;

  /** Last password change or reset. */
  @Prop()
  passwordChangedAt?: Date;

  // ── Admin account actions (Phase 7) ───────────────────────────────────
  @Prop({ trim: true })
  statusReason?: string;

  @Prop()
  statusChangedAt?: Date;

  @Prop({ type: SchemaTypes.ObjectId, ref: "User" })
  statusChangedBy?: Types.ObjectId;
}

export type UserDocument = HydratedDocument<User>;
export const UserSchema = SchemaFactory.createForClass(User);

UserSchema.index({ phone: 1 }, { unique: true });
UserSchema.index({ email: 1 }, { unique: true, sparse: true });
UserSchema.index({ role: 1 });
UserSchema.index({ status: 1 });
// Admin customer/driver lists and "new customers" reports.
UserSchema.index({ role: 1, createdAt: -1 });
