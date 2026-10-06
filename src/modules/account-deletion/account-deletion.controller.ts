import { Body, Controller, HttpCode, HttpStatus, Post } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { ok } from "../../common/http/api-response";
import type { ApiSuccessBody } from "../../common/http/api-response";
import { ThrottlePolicy } from "../../common/throttle/throttle-policies";
import type { AuthenticatedUser } from "../../common/types/jwt-payload";
import { AccountDeletionService } from "./account-deletion.service";
import type { AccountDeletionResult } from "./account-deletion.service";
import { DeleteAccountDto } from "./dto/delete-account.dto";

@ApiTags("Users")
@ApiBearerAuth()
@Controller({ path: "users", version: "1" })
export class AccountDeletionController {
  constructor(private readonly deletion: AccountDeletionService) {}

  // POST rather than DELETE: a request body on DELETE is dropped by some proxies.
  @Post("me/delete-account")
  @HttpCode(HttpStatus.OK)
  @ThrottlePolicy("otpVerify")
  @ApiOperation({
    summary: "Permanently delete the caller's account (password required)",
  })
  async deleteAccount(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: DeleteAccountDto,
  ): Promise<ApiSuccessBody<AccountDeletionResult>> {
    return ok(await this.deletion.deleteAccount(user.userId, dto.password));
  }
}
