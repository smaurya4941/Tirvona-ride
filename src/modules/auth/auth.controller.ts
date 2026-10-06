import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Post,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Public } from "../../common/decorators/public.decorator";
import { ok } from "../../common/http/api-response";
import { ThrottlePolicy } from "../../common/throttle/throttle-policies";
import type { ApiSuccessBody } from "../../common/http/api-response";
import type { AuthenticatedUser } from "../../common/types/jwt-payload";
import type { AuthSession, AuthUserView } from "./auth.service";
import { AuthService } from "./auth.service";
import { LoginDto } from "./dto/login.dto";
import { RequestLoginOtpDto, VerifyLoginOtpDto } from "./dto/login-otp.dto";
import { RefreshTokenDto } from "./dto/refresh-token.dto";
import { RegisterDto } from "./dto/register.dto";
import { PhoneOtpDto } from "./dto/otp-code.dto";
import {
  ForgotPasswordDto,
  ResetPasswordDto,
  VerifyPasswordResetOtpDto,
} from "./dto/password-reset.dto";
import { ResendOtpDto } from "./dto/resend-otp.dto";
import { VerifyOtpDto } from "./dto/verify-otp.dto";
import { LoginOtpService } from "./login-otp.service";
import type { OtpChallengeView } from "./otp-challenge.view";
import type { PasswordResetTicket } from "./password-reset.service";
import { PasswordResetService } from "./password-reset.service";
import type { SignupChallengeView } from "./signup.service";
import { SignupService } from "./signup.service";

@ApiTags("Auth")
@Controller({ path: "auth", version: "1" })
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly signup: SignupService,
    private readonly passwordReset: PasswordResetService,
    private readonly loginOtp: LoginOtpService,
  ) {}

  @Public()
  @ThrottlePolicy("signup")
  @Post("register")
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary:
      "Start a customer or driver signup: sends a 6-digit code to the number on WhatsApp",
    description:
      "No account exists until POST /auth/verify-otp succeeds with the returned verificationId.",
  })
  async register(
    @Body() dto: RegisterDto,
    @Ip() ip: string,
  ): Promise<ApiSuccessBody<SignupChallengeView>> {
    return ok(await this.signup.register(dto, ip));
  }

  @Public()
  @ThrottlePolicy("otpVerify")
  @Post("verify-otp")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Verify the signup code: creates the account and signs the user in",
  })
  async verifyOtp(
    @Body() dto: VerifyOtpDto,
    @Ip() ip: string,
  ): Promise<ApiSuccessBody<AuthSession>> {
    const session = await this.signup.verify(dto, {
      deviceId: dto.deviceId,
      deviceType: dto.deviceType,
      deviceName: dto.deviceName,
      ipAddress: ip,
    });
    return ok(session);
  }

  @Public()
  @ThrottlePolicy("otpSend")
  @Post("resend-otp")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Send a new signup code on WhatsApp (earlier codes stop working)",
  })
  async resendOtp(
    @Body() dto: ResendOtpDto,
  ): Promise<ApiSuccessBody<SignupChallengeView>> {
    return ok(await this.signup.resend(dto));
  }

  @Public()
  @ThrottlePolicy("auth")
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

  // ── Login with a WhatsApp code (alternative to the password) ─────────────

  @Public()
  @ThrottlePolicy("otpSend")
  @Post("login/otp/request")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Log in with a WhatsApp code: send a 6-digit code to the account's number",
    description:
      "Also the resend: inside the cooldown the code already sent is kept (codeSent=false), after it a new code replaces it. 404 ACCOUNT_NOT_FOUND when no customer or driver account uses the number (nothing is sent).",
  })
  async requestLoginOtp(
    @Body() dto: RequestLoginOtpDto,
  ): Promise<ApiSuccessBody<OtpChallengeView>> {
    return ok(await this.loginOtp.requestCode(dto.phone));
  }

  @Public()
  @ThrottlePolicy("otpVerify")
  @Post("login/otp/verify")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Log in with the WhatsApp code: returns the same session as password login",
  })
  async verifyLoginOtp(
    @Body() dto: VerifyLoginOtpDto,
    @Ip() ip: string,
  ): Promise<ApiSuccessBody<AuthSession>> {
    return ok(
      await this.loginOtp.verify(dto.phone, dto.otp, {
        deviceId: dto.deviceId,
        deviceType: dto.deviceType,
        deviceName: dto.deviceName,
        ipAddress: ip,
      }),
    );
  }

  @Public()
  @ThrottlePolicy("refresh")
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
  @ThrottlePolicy("refresh")
  @Post("logout")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Revoke a refresh token / end a session" })
  async logout(
    @Body() dto: RefreshTokenDto,
  ): Promise<ApiSuccessBody<{ loggedOut: true }>> {
    await this.auth.logout(dto.refreshToken);
    return ok({ loggedOut: true });
  }

  @Post("logout-all")
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Sign out on every device, this one included" })
  async logoutAll(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ApiSuccessBody<{ sessionsEnded: number }>> {
    return ok({ sessionsEnded: await this.auth.logoutEverywhere(user.userId) });
  }

  // ── Forgot password (WhatsApp code) ────────────────────────────────────

  @Public()
  @ThrottlePolicy("otpSend")
  @Post("password/forgot")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Forgot password: send a 6-digit reset code to the account's number on WhatsApp",
    description:
      "Inside the resend cooldown the code already sent is kept (codeSent=false). 404 ACCOUNT_NOT_FOUND when no customer or driver account uses the number.",
  })
  async forgotPassword(
    @Body() dto: ForgotPasswordDto,
  ): Promise<ApiSuccessBody<OtpChallengeView>> {
    return ok(await this.passwordReset.requestCode(dto.phone));
  }

  @Public()
  @ThrottlePolicy("otpVerify")
  @Post("password/verify-otp")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Check the reset code; returns a one-time token for choosing the new password",
  })
  async verifyPasswordResetOtp(
    @Body() dto: VerifyPasswordResetOtpDto,
  ): Promise<ApiSuccessBody<PasswordResetTicket>> {
    return ok(await this.passwordReset.verifyCode(dto.phone, dto.otp));
  }

  @Public()
  @ThrottlePolicy("auth")
  @Post("password/reset")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Set a new password with the reset token: signs out every device and signs this one in",
  })
  async resetPassword(
    @Body() dto: ResetPasswordDto,
    @Ip() ip: string,
  ): Promise<ApiSuccessBody<AuthSession>> {
    return ok(
      await this.passwordReset.reset(dto.resetToken, dto.newPassword, {
        deviceId: dto.deviceId,
        deviceType: dto.deviceType,
        deviceName: dto.deviceName,
        ipAddress: ip,
      }),
    );
  }

  @ThrottlePolicy("otpSend")
  @Post("phone/send-otp")
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Send a WhatsApp code to verify the signed-in account's own number (accounts created before signup OTP)",
  })
  async sendPhoneOtp(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ApiSuccessBody<OtpChallengeView>> {
    return ok(await this.signup.sendExistingAccountCode(user.userId));
  }

  @ThrottlePolicy("otpVerify")
  @Post("phone/verify-otp")
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Verify the signed-in account's own number" })
  async verifyPhoneOtp(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: PhoneOtpDto,
  ): Promise<ApiSuccessBody<AuthUserView>> {
    return ok(await this.signup.verifyExistingAccount(user.userId, dto.otp));
  }

  @Get("me")
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Get the authenticated user, including driver status",
  })
  async me(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ApiSuccessBody<AuthUserView>> {
    return ok(await this.auth.me(user.userId));
  }
}
