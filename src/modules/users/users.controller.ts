import { Body, Controller, Get, Patch } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { ok } from "../../common/http/api-response";
import type { ApiSuccessBody } from "../../common/http/api-response";
import type { AuthenticatedUser } from "../../common/types/jwt-payload";
import { ChangePasswordDto } from "./dto/change-password.dto";
import { UpdateProfileDto } from "./dto/update-profile.dto";
import { UsersService } from "./users.service";
import type { UserSummary } from "./users.service";

@ApiTags("Users")
@ApiBearerAuth()
@Controller({ path: "users", version: "1" })
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get("me")
  @ApiOperation({ summary: "Get the authenticated user's profile" })
  async me(
    @CurrentUser() currentUser: AuthenticatedUser,
  ): Promise<ApiSuccessBody<UserSummary>> {
    const user = await this.users.findById(currentUser.userId);
    return ok(this.users.toSummary(user));
  }

  @Patch("me")
  @ApiOperation({ summary: "Update the authenticated user's profile" })
  async updateMe(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Body() dto: UpdateProfileDto,
  ): Promise<ApiSuccessBody<UserSummary>> {
    const user = await this.users.updateProfile(currentUser.userId, dto);
    return ok(this.users.toSummary(user));
  }

  @Patch("me/password")
  @ApiOperation({ summary: "Change the authenticated user's password" })
  async changePassword(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Body() dto: ChangePasswordDto,
  ): Promise<ApiSuccessBody<{ changed: true }>> {
    await this.users.changePassword(currentUser.userId, dto);
    return ok({ changed: true });
  }
}
