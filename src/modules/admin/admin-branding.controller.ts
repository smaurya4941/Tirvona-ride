import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseEnumPipe,
  Put,
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
import { memoryStorage } from "multer";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { apiBadRequest } from "../../common/exceptions/api.exception";
import { ok } from "../../common/http/api-response";
import type { ApiSuccessBody } from "../../common/http/api-response";
import type { AuthenticatedUser } from "../../common/types/jwt-payload";
import { UserRole } from "../../common/types/user-role.enum";
import { AuditLogService } from "../audit/audit-log.service";
import {
  BRAND_ASSET_RULES,
  BrandAssetKind,
  MAX_BRAND_ASSET_BYTES,
} from "../branding/branding-rules";
import { BrandingService } from "../branding/branding.service";
import type {
  BrandAssetView,
  BrandingRulesView,
  BrandingView,
} from "../branding/branding.service";

@ApiTags("Admin · Configuration")
@ApiBearerAuth()
@Roles(UserRole.ADMIN)
@Controller({ path: "admin/branding", version: "1" })
export class AdminBrandingController {
  constructor(
    private readonly branding: BrandingService,
    private readonly audit: AuditLogService,
  ) {}

  @Get()
  @ApiOperation({
    summary: "Current logo and splash screen, with the upload rules for each",
  })
  async get(): Promise<
    ApiSuccessBody<BrandingView & { rules: BrandingRulesView[] }>
  > {
    return ok({
      ...(await this.branding.current()),
      rules: this.branding.rules(),
    });
  }

  @Put(":kind")
  @ApiOperation({
    summary: "Replace the logo or splash screen (multipart field `file`)",
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
      limits: { fileSize: MAX_BRAND_ASSET_BYTES, files: 1 },
    }),
  )
  async replace(
    @Param("kind", new ParseEnumPipe(BrandAssetKind)) kind: BrandAssetKind,
    @CurrentUser() admin: AuthenticatedUser,
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<ApiSuccessBody<BrandAssetView>> {
    if (!file?.buffer?.length)
      throw apiBadRequest(
        "Choose an image to upload",
        "BRANDING_INVALID_IMAGE",
        { hint: BRAND_ASSET_RULES[kind].hint },
      );
    const { view, previousVersion } = await this.branding.replace(
      kind,
      file,
      admin.userId,
    );
    await this.audit.record({
      adminId: admin.userId,
      action: "branding.update",
      targetType: "BRANDING",
      targetId: kind,
      targetLabel: BRAND_ASSET_RULES[kind].label,
      metadata: {
        version: view.version,
        previousVersion,
        width: view.width,
        height: view.height,
        bytes: view.bytes,
      },
    });
    return ok(view);
  }

  @Delete(":kind")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Go back to the default bundled in the apps" })
  async reset(
    @Param("kind", new ParseEnumPipe(BrandAssetKind)) kind: BrandAssetKind,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<ApiSuccessBody<BrandingView>> {
    if (await this.branding.reset(kind))
      await this.audit.record({
        adminId: admin.userId,
        action: "branding.reset",
        targetType: "BRANDING",
        targetId: kind,
        targetLabel: BRAND_ASSET_RULES[kind].label,
      });
    return ok(await this.branding.current());
  }
}
