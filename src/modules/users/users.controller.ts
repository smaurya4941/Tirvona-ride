import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiTags,
} from "@nestjs/swagger";
import type { Response } from "express";
import { memoryStorage } from "multer";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { apiBadRequest } from "../../common/exceptions/api.exception";
import { ok } from "../../common/http/api-response";
import type { ApiSuccessBody } from "../../common/http/api-response";
import type { AuthenticatedUser } from "../../common/types/jwt-payload";
import { ChangePasswordDto } from "./dto/change-password.dto";
import { UpdateProfileDto } from "./dto/update-profile.dto";
import {
  PROFILE_IMAGE_RULE,
  ProfileImagesService,
} from "./profile-images.service";
import { UsersService } from "./users.service";
import type { UserSummary } from "./users.service";

@ApiTags("Users")
@ApiBearerAuth()
@Controller({ path: "users", version: "1" })
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly profileImages: ProfileImagesService,
  ) {}

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

  @Post("profile-image")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Upload or replace the profile photo (multipart field `file`)",
  })
  @ApiConsumes("multipart/form-data")
  @ApiBody({
    schema: {
      type: "object",
      properties: { file: { type: "string", format: "binary" } },
    },
  })
  // Kept in memory: the bytes go straight into MongoDB, nothing touches disk.
  @UseInterceptors(
    FileInterceptor("file", {
      storage: memoryStorage(),
      limits: { fileSize: PROFILE_IMAGE_RULE.maxBytes, files: 1 },
    }),
  )
  async uploadProfileImage(
    @CurrentUser() currentUser: AuthenticatedUser,
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<ApiSuccessBody<UserSummary>> {
    if (!file?.buffer?.length)
      throw apiBadRequest("Choose a photo to upload", "PROFILE_IMAGE_INVALID", {
        hint: PROFILE_IMAGE_RULE.hint,
      });
    await this.profileImages.replace(currentUser.userId, file);
    return ok(
      this.users.toSummary(await this.users.findById(currentUser.userId)),
    );
  }

  @Delete("profile-image")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Remove the profile photo" })
  async removeProfileImage(
    @CurrentUser() currentUser: AuthenticatedUser,
  ): Promise<ApiSuccessBody<UserSummary>> {
    await this.profileImages.remove(currentUser.userId);
    return ok(
      this.users.toSummary(await this.users.findById(currentUser.userId)),
    );
  }

  /**
   * The caller's own photo. Private (bearer token required); cached per
   * device for a year when `v` matches, since a new photo gets a new `v`.
   */
  @Get("me/profile-image")
  @ApiOperation({ summary: "The authenticated user's profile photo" })
  async profileImage(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Headers("if-none-match") ifNoneMatch: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile | undefined> {
    const meta = await this.profileImages.describe(currentUser.userId);
    const etag = `"${meta.version}"`;
    response.setHeader("ETag", etag);
    response.setHeader("Cache-Control", "private, max-age=31536000, immutable");
    if (ifNoneMatch === etag) {
      response.status(304);
      return undefined;
    }
    const file = await this.profileImages.content(currentUser.userId);
    const options = { type: file.contentType, length: file.length };
    return Buffer.isBuffer(file.body) ? new StreamableFile(file.body, options) : new StreamableFile(file.body, options);
  }
}
