import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { InjectModel } from "@nestjs/mongoose";
import type { Model } from "mongoose";
import type { JwtAccessPayload } from "../../common/types/jwt-payload";
import { UserRole } from "../../common/types/user-role.enum";
import { DriverProfile } from "../drivers/schemas/driver-profile.schema";
import { User, UserStatus } from "../users/schemas/user.schema";
import { RealtimeErrorCode } from "./realtime.constants";
import type { SocketIdentity } from "./realtime.types";

/** Rejection surfaced to the client as a Socket.IO `connect_error`. */
export class SocketAuthError extends Error {
  readonly data: { code: string; message: string };

  constructor(code: string, message: string) {
    // The message *is* the code so every client can branch on it; the human
    // text travels in `data`.
    super(code);
    this.name = "SocketAuthError";
    this.data = { code, message };
  }
}

export interface HandshakeLike {
  auth?: Record<string, unknown>;
  headers?: Record<string, string | string[] | undefined>;
}

/**
 * Handshake authentication: the same access token, issuer, audience and
 * secret as the REST JwtAuthGuard, plus the checks a long-lived connection
 * needs up front (account still active, driver profile resolved).
 */
@Injectable()
export class SocketAuthService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    @InjectModel(User.name) private readonly userModel: Model<User>,
    @InjectModel(DriverProfile.name) private readonly driverModel: Model<DriverProfile>,
  ) {}

  /** `auth: { token }` (preferred) or an `Authorization: Bearer` header. Never a query string. */
  extractToken(handshake: HandshakeLike): string | undefined {
    const fromAuth = handshake.auth?.token;
    if (typeof fromAuth === "string" && fromAuth.trim())
      return fromAuth.replace(/^Bearer\s+/i, "").trim();
    const header = handshake.headers?.authorization;
    const value = Array.isArray(header) ? header[0] : header;
    if (value?.startsWith("Bearer ")) return value.slice("Bearer ".length).trim() || undefined;
    return undefined;
  }

  async authenticate(handshake: HandshakeLike): Promise<SocketIdentity> {
    const token = this.extractToken(handshake);
    if (!token) throw new SocketAuthError(RealtimeErrorCode.AUTH_UNAUTHORIZED, "Authentication required");

    let payload: JwtAccessPayload & { exp?: number };
    try {
      payload = await this.jwt.verifyAsync<JwtAccessPayload & { exp?: number }>(token, {
        secret: this.config.getOrThrow<string>("jwtAccessSecret"),
        issuer: this.config.get<string>("jwtIssuer"),
        audience: this.config.get<string>("jwtAudience"),
      });
    } catch {
      throw new SocketAuthError(
        RealtimeErrorCode.AUTH_TOKEN_EXPIRED,
        "Your session has expired. Please sign in again.",
      );
    }

    if (payload.role !== UserRole.CUSTOMER && payload.role !== UserRole.DRIVER)
      throw new SocketAuthError(
        RealtimeErrorCode.AUTH_FORBIDDEN,
        "Realtime is available to customers and drivers only",
      );

    const user = await this.userModel.findById(payload.sub).select("status").lean().exec();
    if (!user) throw new SocketAuthError(RealtimeErrorCode.AUTH_UNAUTHORIZED, "Account not found");
    if (user.status !== UserStatus.ACTIVE)
      throw new SocketAuthError(RealtimeErrorCode.USER_BLOCKED, "This account cannot connect");

    const identity: SocketIdentity = {
      userId: payload.sub,
      role: payload.role,
      tokenExpiresAt: (payload.exp ?? Math.floor(Date.now() / 1000) + 900) * 1000,
    };
    if (payload.role === UserRole.DRIVER) {
      const driver = await this.driverModel.findOne({ userId: payload.sub }).select("_id").lean().exec();
      // A driver still onboarding may connect; driver-only actions check approval.
      if (driver) identity.driverId = driver._id.toString();
    }
    return identity;
  }
}
