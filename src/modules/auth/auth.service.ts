import { Injectable } from "@nestjs/common";
import { DomainEventsService } from "../../infrastructure/events/domain-events.service";
import { UserRole } from "../../common/types/user-role.enum";
import { UserStatus } from "../users/schemas/user.schema";
import type { UserDocument } from "../users/schemas/user.schema";
import type { UserSummary } from "../users/users.service";
import { UsersService } from "../users/users.service";
import { DriversService } from "../drivers/drivers.service";
import { apiForbidden, apiUnauthorized } from "../../common/exceptions/api.exception";
import { LoginDto } from "./dto/login.dto";
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
    private readonly domainEvents: DomainEventsService,
  ) {}

  /** Issues a token pair for a user who just proved who they are. */
  async startSession(userId: string, role: UserRole, device: DeviceMetadata): Promise<AuthSession> {
    const tokens = await this.tokens.issueTokenPair(userId, role, device);
    return { user: await this.buildUserView(userId), ...tokens };
  }

  async login(dto: LoginDto, device: DeviceMetadata): Promise<AuthSession> {
    return this.authenticate(dto, device);
  }

  /**
   * Admin panel sign-in. Only ADMIN accounts get a session; any other
   * account receives the same generic error as a wrong password, so this
   * endpoint cannot be used to learn which phone numbers are admins.
   */
  async loginAdmin(dto: LoginDto, device: DeviceMetadata): Promise<AuthSession> {
    return this.authenticate(dto, device, UserRole.ADMIN);
  }

  private async authenticate(dto: LoginDto, device: DeviceMetadata, requiredRole?: UserRole): Promise<AuthSession> {
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
    if (requiredRole && user.role !== requiredRole) throw invalidCredentials;
    this.assertCanSignIn(user);
    return this.completeSignIn(user, device);
  }

  /**
   * Rules every sign-in method enforces once it knows *who* is signing in
   * (password, WhatsApp code, …). Kept in one place so the methods cannot
   * drift apart.
   */
  assertCanSignIn(user: Pick<UserDocument, "status">): void {
    if (user.status === UserStatus.BLOCKED)
      throw apiForbidden("This account has been blocked", "USER_BLOCKED");
  }

  /** Records the login and opens a session for a user who passed assertCanSignIn. */
  async completeSignIn(user: Pick<UserDocument, "_id" | "role">, device: DeviceMetadata): Promise<AuthSession> {
    const userId = user._id.toString();
    await this.users.recordLogin(userId);
    return this.startSession(userId, user.role, device);
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

  /** Ends every session of the user (all devices, the caller's included). */
  async logoutEverywhere(userId: string): Promise<number> {
    const ended = await this.tokens.revokeAllForUser(userId);
    this.domainEvents.emit("auth.sessions_revoked", { userId, reason: "SIGN_OUT_EVERYWHERE" });
    return ended;
  }

  async me(userId: string): Promise<AuthUserView> {
    return this.buildUserView(userId);
  }

  async buildUserView(userId: string): Promise<AuthUserView> {
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
