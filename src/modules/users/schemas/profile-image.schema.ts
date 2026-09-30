import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, Types } from "mongoose";
import type { HydratedDocument } from "mongoose";

/**
 * A user's profile photo, stored in MongoDB like the branding and popular
 * place images: no file storage to provision, and it moves with backups.
 * One per user; uploading replaces it. `users.profileImage` holds the
 * versioned app path so clients refetch only when the photo changes.
 */
@Schema({ collection: "profile_images", timestamps: true, versionKey: false })
export class ProfileImage {
  @Prop({ required: true, type: SchemaTypes.ObjectId, ref: "User" })
  userId!: Types.ObjectId;

  @Prop({ required: true })
  contentType!: string;

  /** Never loaded unless asked for (`.select("+data")`). */
  @Prop({ required: true, type: Buffer, select: false })
  data!: Buffer;

  @Prop({ required: true })
  bytes!: number;

  @Prop({ required: true })
  width!: number;

  @Prop({ required: true })
  height!: number;

  /** Content hash prefix: the cache key in the photo's URL. */
  @Prop({ required: true })
  version!: string;

  createdAt!: Date;
  updatedAt!: Date;
}

export type ProfileImageDocument = HydratedDocument<ProfileImage>;
export const ProfileImageSchema = SchemaFactory.createForClass(ProfileImage);

ProfileImageSchema.index({ userId: 1 }, { unique: true });
