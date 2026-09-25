import { Injectable } from "@nestjs/common";
import type { CanActivate, ExecutionContext } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { apiUnauthorized } from "../exceptions/api.exception";
import { IS_PUBLIC_KEY } from "../decorators/public.decorator";
import type { AuthenticatedRequest } from "../types/authenticated-request";
import type { JwtAccessPayload } from "../types/jwt-payload";

// Applied globally (see AuthModule). Verifies the access token and attaches
// `request.user`; routes opt out with @Public(). RolesGuard runs after this
// and relies on `request.user` being set.
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // WebSocket handlers authenticate once at the handshake (RealtimeGateway).
    if (context.getType() !== "http") return true;

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const token = this.extractToken(request);
    if (!token)
      throw apiUnauthorized("Authentication required", "AUTH_UNAUTHORIZED");

    try {
      const payload = await this.jwtService.verifyAsync<JwtAccessPayload>(
        token,
        {
          secret: this.config.getOrThrow<string>("jwtAccessSecret"),
          issuer: this.config.get<string>("jwtIssuer"),
          audience: this.config.get<string>("jwtAudience"),
        },
      );
      (request as AuthenticatedRequest).user = {
        userId: payload.sub,
        role: payload.role,
      };
      return true;
    } catch {
      throw apiUnauthorized(
        "Your session has expired. Please sign in again.",
        "AUTH_TOKEN_EXPIRED",
      );
    }
  }

  private extractToken(request: Request): string | undefined {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) return undefined;
    return header.slice("Bearer ".length).trim() || undefined;
  }
}
