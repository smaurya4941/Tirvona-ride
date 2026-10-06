import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import type { Model } from "mongoose";
import * as argon2 from "argon2";
import {
  apiBadRequest,
  apiConflict,
  apiNotFound,
} from "../../common/exceptions/api.exception";
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
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<User>,
  ) {}

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

  async findByPhone(phone: string): Promise<UserDocument | null> {
    return this.userModel.findOne({ phone }).exec();
  }

  async findByIdWithPassword(userId: string): Promise<UserDocument | null> {
    return this.userModel.findById(userId).select("+passwordHash").exec();
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

  async existsByPhone(phone: string): Promise<boolean> {
    return (await this.userModel.exists({ phone })) !== null;
  }

  async existsByEmail(email: string): Promise<boolean> {
    return (
      (await this.userModel.exists({ email: email.trim().toLowerCase() })) !==
      null
    );
  }

  async hashPassword(password: string): Promise<string> {
    return argon2.hash(password);
  }

  async create(input: CreateUserInput): Promise<UserDocument> {
    const passwordHash = await this.hashPassword(input.password);
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

  /**
   * Creates the account of a signup whose WhatsApp code was just verified:
   * the password was hashed when the form was submitted, and the phone is
   * verified from the first moment the user exists.
   */
  async createVerified(
    input: Omit<CreateUserInput, "password"> & { passwordHash: string },
  ): Promise<UserDocument> {
    return this.userModel.create({
      phone: input.phone,
      email: input.email,
      passwordHash: input.passwordHash,
      role: input.role,
      firstName: input.firstName,
      lastName: input.lastName,
      status: UserStatus.ACTIVE,
      isPhoneVerified: true,
    });
  }

  /** Compensation only: undoes an account whose signup could not finish. */
  async deleteById(userId: string): Promise<void> {
    await this.userModel.deleteOne({ _id: userId }).exec();
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
    if (dto.lastName !== undefined) user.lastName = dto.lastName || undefined;
    if (dto.gender !== undefined) user.gender = dto.gender;
    if (dto.dob !== undefined) {
      const dob = new Date(dto.dob);
      if (dob.getTime() >= Date.now() || dob.getUTCFullYear() < 1900)
        throw apiBadRequest("Enter a real date of birth", "VALIDATION_FAILED");
      user.dob = dob;
    }
    if (dto.email !== undefined) {
      const email = dto.email ?? undefined;
      if (email !== user.email) {
        if (
          email &&
          (await this.userModel.exists({ email, _id: { $ne: user._id } }))
        )
          throw this.emailTaken();
        user.email = email;
        // A new address has not been proven yet.
        user.isEmailVerified = false;
      }
    }
    try {
      await user.save();
    } catch (error) {
      // Someone claimed the address between the check and the save.
      if ((error as { code?: number })?.code === 11000) throw this.emailTaken();
      throw error;
    }
    return user;
  }

  /** Sets a new password (already validated against the policy). */
  async setPassword(
    userId: string,
    password: string,
    options: { markPhoneVerified?: boolean } = {},
  ): Promise<void> {
    await this.userModel
      .updateOne(
        { _id: userId },
        {
          $set: {
            passwordHash: await this.hashPassword(password),
            passwordChangedAt: new Date(),
            ...(options.markPhoneVerified ? { isPhoneVerified: true } : {}),
          },
        },
      )
      .exec();
  }

  async changePassword(userId: string, dto: ChangePasswordDto): Promise<void> {
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

    if (await argon2.verify(user.passwordHash!, dto.newPassword))
      throw apiBadRequest(
        "Choose a password you haven't used for this account.",
        "PASSWORD_UNCHANGED",
      );

    user.passwordHash = await argon2.hash(dto.newPassword);
    user.passwordChangedAt = new Date();
    await user.save();
  }

  private emailTaken() {
    return apiConflict(
      "This email is already used by another account.",
      "EMAIL_ALREADY_REGISTERED",
    );
  }
}
