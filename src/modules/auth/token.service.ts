import { createHash } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectModel } from "@nestjs/mongoose";
import { JwtService } from "@nestjs/jwt";
import type { JwtSignOptions } from "@nestjs/jwt";
import type { Model } from "mongoose";
import { Types } from "mongoose";
import { apiUnauthorized } from "../../common/exceptions/api.exception";
import type { UserRole } from "../../common/types/user-role.enum";
import type {
  JwtAccessPayload,
  JwtRefreshPayload,
} from "../../common/types/jwt-payload";
import { UserSession } from "./schemas/user-session.schema";
import type { UserSessionDocument } from "./schemas/user-session.schema";

export interface DeviceMetadata {
  deviceId?: string;
  deviceType?: string;
  deviceName?: string;
  ipAddress?: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

const hashToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

@Injectable()
export class TokenService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    @InjectModel(UserSession.name)
    private readonly sessionModel: Model<UserSession>,
  ) {}

  signAccessToken(userId: string, role: UserRole): string {
    const payload: JwtAccessPayload = { sub: userId, role };
    return this.jwtService.sign(payload, {
      secret: this.config.getOrThrow<string>("jwtAccessSecret"),
      expiresIn: this.config.get<string>(
        "jwtAccessExpiresIn",
      ) as JwtSignOptions["expiresIn"],
      issuer: this.config.get<string>("jwtIssuer"),
      audience: this.config.get<string>("jwtAudience"),
    });
  }

  /** Creates a session record and returns a fresh access+refresh pair. */
  async issueTokenPair(
    userId: string,
    role: UserRole,
    device: DeviceMetadata,
  ): Promise<TokenPair> {
    const refreshExpiresIn =
      this.config.get<string>("jwtRefreshExpiresIn") ?? "30d";
    const sessionId = new Types.ObjectId();

    const refreshToken = this.jwtService.sign(
      { sub: userId, sid: sessionId.toString() } satisfies JwtRefreshPayload,
      {
        secret: this.config.getOrThrow<string>("jwtRefreshSecret"),
        expiresIn: refreshExpiresIn as JwtSignOptions["expiresIn"],
        issuer: this.config.get<string>("jwtIssuer"),
        audience: this.config.get<string>("jwtAudience"),
      },
    );

    await this.sessionModel.create({
      _id: sessionId,
      userId: new Types.ObjectId(userId),
      refreshTokenHash: hashToken(refreshToken),
      deviceId: device.deviceId,
      deviceType: device.deviceType,
      deviceName: device.deviceName,
      ipAddress: device.ipAddress,
      isActive: true,
      expiresAt: this.expiryDate(refreshExpiresIn),
      lastUsedAt: new Date(),
    });

    return { accessToken: this.signAccessToken(userId, role), refreshToken };
  }

  /** Verifies a refresh token against both its signature and the stored session. */
  async verifyRefreshToken(
    refreshToken: string,
  ): Promise<UserSessionDocument> {
    let payload: JwtRefreshPayload;
    try {
      payload = await this.jwtService.verifyAsync<JwtRefreshPayload>(
        refreshToken,
        {
          secret: this.config.getOrThrow<string>("jwtRefreshSecret"),
          issuer: this.config.get<string>("jwtIssuer"),
          audience: this.config.get<string>("jwtAudience"),
        },
      );
    } catch {
      throw apiUnauthorized(
        "Refresh token is invalid or expired",
        "AUTH_REFRESH_TOKEN_INVALID",
      );
    }

    const session = await this.sessionModel.findById(payload.sid).exec();
    if (
      !session ||
      !session.isActive ||
      session.userId.toString() !== payload.sub ||
      session.refreshTokenHash !== hashToken(refreshToken) ||
      session.expiresAt.getTime() < Date.now()
    ) {
      throw apiUnauthorized(
        "Refresh token is invalid or expired",
        "AUTH_REFRESH_TOKEN_INVALID",
      );
    }

    return session;
  }

  /** Rotation: the presented refresh token is single-use — revoke it once redeemed. */
  async revokeSession(sessionId: Types.ObjectId): Promise<void> {
    await this.sessionModel
      .updateOne({ _id: sessionId }, { $set: { isActive: false } })
      .exec();
  }

  private expiryDate(duration: string): Date {
    const match = /^(\d+)([smhd])$/.exec(duration);
    const amount = match ? Number(match[1]) : 30;
    const unit = match ? match[2] : "d";
    const unitMs = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[
      unit as "s" | "m" | "h" | "d"
    ];
    return new Date(Date.now() + amount * unitMs);
  }
}
