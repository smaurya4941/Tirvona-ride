import { Injectable } from "@nestjs/common";
import { DomainEventsService } from "../../infrastructure/events/domain-events.service";
import { UserRole } from "../../common/types/user-role.enum";
import { UserStatus } from "../users/schemas/user.schema";
import type { UserSummary } from "../users/users.service";
import { UsersService } from "../users/users.service";
import { DriversService } from "../drivers/drivers.service";
import {
  apiConflict,
  apiForbidden,
  apiUnauthorized,
} from "../../common/exceptions/api.exception";
import { LoginDto } from "./dto/login.dto";
import { RegisterDto } from "./dto/register.dto";
import { SendOtpDto } from "./dto/send-otp.dto";
import { VerifyOtpDto } from "./dto/verify-otp.dto";
import { OtpPurpose } from "./schemas/otp-verification.schema";
import { OtpService } from "./otp.service";
import type { DeviceMetadata } from "./token.service";
import { TokenService } from "./token.service";

export interface DriverStatusView {
  driverStatus: string;
  rejectionReason?: string;
}

export type AuthUserView = UserSummary & { driver?: DriverStatusView };

export interface AuthSession {
  user: AuthUserView;
  accessToken: string;
  refreshToken: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly drivers: DriversService,
    private readonly tokens: TokenService,
    private readonly otp: OtpService,
    private readonly domainEvents: DomainEventsService,
  ) {}

  async register(dto: RegisterDto, device: DeviceMetadata): Promise<AuthSession> {
    if (await this.users.existsByPhoneOrEmail(dto.phone, dto.email))
      throw apiConflict(
        "An account with this phone or email already exists",
        "USER_ALREADY_EXISTS",
      );

    const user = await this.users.create({
      phone: dto.phone,
      email: dto.email,
      password: dto.password,
      role: dto.role,
      firstName: dto.firstName,
      lastName: dto.lastName,
    });

    if (dto.role === UserRole.DRIVER)
      await this.drivers.createProfileForUser(user._id.toString());

    const tokens = await this.tokens.issueTokenPair(
      user._id.toString(),
      user.role,
      device,
    );
    return { user: await this.buildUserView(user._id.toString()), ...tokens };
  }

  async login(dto: LoginDto, device: DeviceMetadata): Promise<AuthSession> {
    const user = await this.users.findByPhoneWithPassword(dto.phone);
    // Same generic error whether the phone is unknown or the password is
    // wrong — distinguishing the two lets an attacker enumerate accounts.
    const invalidCredentials = apiUnauthorized(
      "Incorrect phone number or password",
      "AUTH_INVALID_CREDENTIALS",
    );
    if (!user) throw invalidCredentials;
    if (!(await this.users.verifyPassword(user, dto.password)))
      throw invalidCredentials;
    if (user.status === UserStatus.BLOCKED)
      throw apiForbidden("This account has been blocked", "USER_BLOCKED");

    await this.users.recordLogin(user._id.toString());
    const tokens = await this.tokens.issueTokenPair(
      user._id.toString(),
      user.role,
      device,
    );
    return { user: await this.buildUserView(user._id.toString()), ...tokens };
  }

  async refresh(refreshToken: string, device: DeviceMetadata): Promise<AuthSession> {
    const session = await this.tokens.verifyRefreshToken(refreshToken);
    const user = await this.users.findById(session.userId.toString());
    if (user.status === UserStatus.BLOCKED) {
      await this.tokens.revokeSession(session._id);
      throw apiForbidden("This account has been blocked", "USER_BLOCKED");
    }

    // Rotation: the redeemed refresh token is single-use.
    await this.tokens.revokeSession(session._id);
    const tokens = await this.tokens.issueTokenPair(
      user._id.toString(),
      user.role,
      device,
    );
    return { user: await this.buildUserView(user._id.toString()), ...tokens };
  }

  async logout(refreshToken: string): Promise<void> {
    try {
      const session = await this.tokens.verifyRefreshToken(refreshToken);
      await this.tokens.revokeSession(session._id);
      // The device's push tokens stop receiving this user's notifications.
      this.domainEvents.emit("auth.logged_out", {
        userId: session.userId.toString(),
        deviceId: session.deviceId,
      });
    } catch {
      // Already invalid/expired — logging out is idempotent either way.
    }
  }

  async sendOtp(dto: SendOtpDto): Promise<void> {
    await this.otp.send(dto.phone, OtpPurpose.PHONE_VERIFICATION);
  }

  async verifyOtp(dto: VerifyOtpDto): Promise<void> {
    await this.otp.verify(dto.phone, OtpPurpose.PHONE_VERIFICATION, dto.otp);
    const user = await this.users.findByPhoneWithPassword(dto.phone);
    if (user) await this.users.markPhoneVerified(user._id.toString());
  }

  async me(userId: string): Promise<AuthUserView> {
    return this.buildUserView(userId);
  }

  private async buildUserView(userId: string): Promise<AuthUserView> {
    const user = await this.users.findById(userId);
    const summary = this.users.toSummary(user);
    if (summary.role !== UserRole.DRIVER) return summary;

    const driver = await this.drivers.findByUserId(userId);
    if (!driver) return summary;
    return {
      ...summary,
      driver: {
        driverStatus: driver.driverStatus,
        rejectionReason: driver.rejectionReason,
      },
    };
  }
}
