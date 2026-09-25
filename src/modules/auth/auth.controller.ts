import { Body, Controller, Get, HttpCode, HttpStatus, Ip, Post } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Public } from "../../common/decorators/public.decorator";
import { ok } from "../../common/http/api-response";
import type { ApiSuccessBody } from "../../common/http/api-response";
import type { AuthenticatedUser } from "../../common/types/jwt-payload";
import type { AuthSession, AuthUserView } from "./auth.service";
import { AuthService } from "./auth.service";
import { LoginDto } from "./dto/login.dto";
import { RefreshTokenDto } from "./dto/refresh-token.dto";
import { RegisterDto } from "./dto/register.dto";
import { SendOtpDto } from "./dto/send-otp.dto";
import { VerifyOtpDto } from "./dto/verify-otp.dto";

@ApiTags("Auth")
@Controller({ path: "auth", version: "1" })
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post("register")
  @ApiOperation({ summary: "Register a customer or driver account" })
  async register(
    @Body() dto: RegisterDto,
    @Ip() ip: string,
  ): Promise<ApiSuccessBody<AuthSession>> {
    const session = await this.auth.register(dto, {
      deviceId: dto.deviceId,
      deviceType: dto.deviceType,
      deviceName: dto.deviceName,
      ipAddress: ip,
    });
    return ok(session);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post("login")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Log in with phone and password" })
  async login(
    @Body() dto: LoginDto,
    @Ip() ip: string,
  ): Promise<ApiSuccessBody<AuthSession>> {
    const session = await this.auth.login(dto, {
      deviceId: dto.deviceId,
      deviceType: dto.deviceType,
      deviceName: dto.deviceName,
      ipAddress: ip,
    });
    return ok(session);
  }

  @Public()
  @Post("refresh")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Exchange a refresh token for a new token pair" })
  async refresh(
    @Body() dto: RefreshTokenDto,
    @Ip() ip: string,
  ): Promise<ApiSuccessBody<AuthSession>> {
    const session = await this.auth.refresh(dto.refreshToken, {
      ipAddress: ip,
    });
    return ok(session);
  }

  @Public()
  @Post("logout")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Revoke a refresh token / end a session" })
  async logout(
    @Body() dto: RefreshTokenDto,
  ): Promise<ApiSuccessBody<{ loggedOut: true }>> {
    await this.auth.logout(dto.refreshToken);
    return ok({ loggedOut: true });
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post("send-otp")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Send a verification code (logged in dev)" })
  async sendOtp(
    @Body() dto: SendOtpDto,
  ): Promise<ApiSuccessBody<{ sent: true }>> {
    await this.auth.sendOtp(dto);
    return ok({ sent: true });
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post("verify-otp")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Verify a phone number with its OTP" })
  async verifyOtp(
    @Body() dto: VerifyOtpDto,
  ): Promise<ApiSuccessBody<{ verified: true }>> {
    await this.auth.verifyOtp(dto);
    return ok({ verified: true });
  }

  @Get("me")
  @ApiBearerAuth()
  @ApiOperation({ summary: "Get the authenticated user, including driver status" })
  async me(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ApiSuccessBody<AuthUserView>> {
    return ok(await this.auth.me(user.userId));
  }
}
