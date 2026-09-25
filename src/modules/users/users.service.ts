import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import type { Model } from "mongoose";
import * as argon2 from "argon2";
import { apiBadRequest, apiNotFound } from "../../common/exceptions/api.exception";
import type { UserRole } from "../../common/types/user-role.enum";
import { User, UserStatus } from "./schemas/user.schema";
import type { UserDocument } from "./schemas/user.schema";
import type { UpdateProfileDto } from "./dto/update-profile.dto";
import type { ChangePasswordDto } from "./dto/change-password.dto";

export interface CreateUserInput {
  phone: string;
  email?: string;
  password: string;
  role: UserRole;
  firstName: string;
  lastName?: string;
}

export interface UserSummary {
  id: string;
  phone: string;
  email?: string;
  role: UserRole;
  status: UserStatus;
  firstName: string;
  lastName?: string;
  profileImage?: string;
  gender?: string;
  dob?: Date;
  isPhoneVerified: boolean;
  isEmailVerified: boolean;
  lastLoginAt?: Date;
  createdAt: Date;
}

@Injectable()
export class UsersService {
  constructor(@InjectModel(User.name) private readonly userModel: Model<User>) {}

  toSummary(user: UserDocument): UserSummary {
    return {
      id: user._id.toString(),
      phone: user.phone,
      email: user.email,
      role: user.role,
      status: user.status,
      firstName: user.firstName,
      lastName: user.lastName,
      profileImage: user.profileImage,
      gender: user.gender,
      dob: user.dob,
      isPhoneVerified: user.isPhoneVerified,
      isEmailVerified: user.isEmailVerified,
      lastLoginAt: user.lastLoginAt,
      createdAt: user.get("createdAt") as Date,
    };
  }

  async findByPhoneWithPassword(phone: string): Promise<UserDocument | null> {
    return this.userModel.findOne({ phone }).select("+passwordHash").exec();
  }

  async findById(userId: string): Promise<UserDocument> {
    const user = await this.userModel.findById(userId).exec();
    if (!user) throw apiNotFound("User not found", "USER_NOT_FOUND");
    return user;
  }

  async existsByPhoneOrEmail(phone: string, email?: string): Promise<boolean> {
    const query = email ? { $or: [{ phone }, { email }] } : { phone };
    return (await this.userModel.exists(query)) !== null;
  }

  async create(input: CreateUserInput): Promise<UserDocument> {
    const passwordHash = await argon2.hash(input.password);
    return this.userModel.create({
      phone: input.phone,
      email: input.email,
      passwordHash,
      role: input.role,
      firstName: input.firstName,
      lastName: input.lastName,
      status: UserStatus.ACTIVE,
    });
  }

  async verifyPassword(user: UserDocument, password: string): Promise<boolean> {
    if (!user.passwordHash) return false;
    return argon2.verify(user.passwordHash, password);
  }

  async recordLogin(userId: string): Promise<void> {
    await this.userModel
      .updateOne({ _id: userId }, { $set: { lastLoginAt: new Date() } })
      .exec();
  }

  async markPhoneVerified(userId: string): Promise<void> {
    await this.userModel
      .updateOne({ _id: userId }, { $set: { isPhoneVerified: true } })
      .exec();
  }

  async updateProfile(
    userId: string,
    dto: UpdateProfileDto,
  ): Promise<UserDocument> {
    const user = await this.findById(userId);
    if (dto.firstName !== undefined) user.firstName = dto.firstName;
    if (dto.lastName !== undefined) user.lastName = dto.lastName;
    if (dto.gender !== undefined) user.gender = dto.gender;
    if (dto.dob !== undefined) user.dob = new Date(dto.dob);
    await user.save();
    return user;
  }

  async changePassword(
    userId: string,
    dto: ChangePasswordDto,
  ): Promise<void> {
    const user = await this.userModel
      .findById(userId)
      .select("+passwordHash")
      .exec();
    if (!user) throw apiNotFound("User not found", "USER_NOT_FOUND");

    const matches = user.passwordHash
      ? await argon2.verify(user.passwordHash, dto.currentPassword)
      : false;
    if (!matches)
      throw apiBadRequest(
        "Current password is incorrect",
        "AUTH_INVALID_CREDENTIALS",
      );

    user.passwordHash = await argon2.hash(dto.newPassword);
    await user.save();
  }
}
