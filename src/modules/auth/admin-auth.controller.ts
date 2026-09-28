import { Body, Controller, HttpCode, HttpStatus, Ip, Post } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { Public } from "../../common/decorators/public.decorator";
import { ok } from "../../common/http/api-response";
import type { ApiSuccessBody } from "../../common/http/api-response";
import { ThrottlePolicy } from "../../common/throttle/throttle-policies";
import type { AuthSession } from "./auth.service";
import { AuthService } from "./auth.service";
import { LoginDto } from "./dto/login.dto";

/**
 * The admin panel's sign-in. Separate from /auth/login so it can carry the
 * strictest rate limit and refuse every non-admin account. Token refresh and
 * logout reuse /auth/refresh and /auth/logout.
 */
@ApiTags("Admin · Auth")
@Controller({ path: "admin/auth", version: "1" })
export class AdminAuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @ThrottlePolicy("adminLogin")
  @Post("login")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Admin sign-in (ADMIN accounts only)" })
  async login(@Body() dto: LoginDto, @Ip() ip: string): Promise<ApiSuccessBody<AuthSession>> {
    return ok(
      await this.auth.loginAdmin(dto, {
        deviceId: dto.deviceId,
        deviceType: dto.deviceType ?? "admin-web",
        deviceName: dto.deviceName,
        ipAddress: ip,
      }),
    );
  }
}
