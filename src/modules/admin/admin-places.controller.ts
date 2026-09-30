import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiTags } from "@nestjs/swagger";
import { memoryStorage } from "multer";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { apiBadRequest } from "../../common/exceptions/api.exception";
import { ok } from "../../common/http/api-response";
import type { ApiSuccessBody } from "../../common/http/api-response";
import { ParseObjectIdPipe } from "../../common/pipes/parse-object-id.pipe";
import type { AuthenticatedUser } from "../../common/types/jwt-payload";
import { UserRole } from "../../common/types/user-role.enum";
import { AuditLogService } from "../audit/audit-log.service";
import { CreatePopularPlaceDto, UpdatePopularPlaceDto } from "../places/dto/popular-place.dto";
import { POPULAR_IMAGE_RULE, PopularPlacesService } from "../places/popular-places.service";
import type { PopularPlaceAdminView } from "../places/popular-places.service";

/** "Popular destinations" shown on the rider's Home and search screens. */
@ApiTags("Admin · Configuration")
@ApiBearerAuth()
@Roles(UserRole.ADMIN)
@Controller({ path: "admin/popular-places", version: "1" })
export class AdminPopularPlacesController {
  constructor(
    private readonly places: PopularPlacesService,
    private readonly audit: AuditLogService,
  ) {}

  @Get()
  @ApiOperation({ summary: "Every popular place (active and hidden), with the photo rules" })
  async list(): Promise<ApiSuccessBody<{ places: PopularPlaceAdminView[]; imageRule: typeof POPULAR_IMAGE_RULE }>> {
    return ok({ places: await this.places.list(), imageRule: POPULAR_IMAGE_RULE });
  }

  @Post()
  @ApiOperation({ summary: "Add a popular place" })
  async create(
    @Body() dto: CreatePopularPlaceDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<ApiSuccessBody<PopularPlaceAdminView>> {
    const place = await this.places.create(dto, admin.userId);
    await this.record(admin, "popular_place.create", place, { city: place.city, active: place.active });
    return ok(place);
  }

  @Patch(":id")
  @ApiOperation({ summary: "Edit, hide or re-order a popular place" })
  async update(
    @Param("id", ParseObjectIdPipe) id: string,
    @Body() dto: UpdatePopularPlaceDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<ApiSuccessBody<PopularPlaceAdminView>> {
    const place = await this.places.update(id, dto, admin.userId);
    await this.record(admin, "popular_place.update", place, { changes: { ...dto } });
    return ok(place);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Delete a popular place (hide it instead to keep it for later)" })
  async remove(
    @Param("id", ParseObjectIdPipe) id: string,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<ApiSuccessBody<{ deleted: true }>> {
    const name = await this.places.remove(id);
    await this.audit.record({
      adminId: admin.userId,
      action: "popular_place.delete",
      targetType: "POPULAR_PLACE",
      targetId: id,
      targetLabel: name,
    });
    return ok({ deleted: true });
  }

  @Put(":id/image")
  @ApiOperation({ summary: "Set or replace the place's photo (multipart field `file`)" })
  @ApiConsumes("multipart/form-data")
  @ApiBody({ schema: { type: "object", properties: { file: { type: "string", format: "binary" } } } })
  // Kept in memory: the bytes go straight into MongoDB, nothing touches disk.
  @UseInterceptors(FileInterceptor("file", { storage: memoryStorage(), limits: { fileSize: POPULAR_IMAGE_RULE.maxBytes, files: 1 } }))
  async setImage(
    @Param("id", ParseObjectIdPipe) id: string,
    @CurrentUser() admin: AuthenticatedUser,
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<ApiSuccessBody<PopularPlaceAdminView>> {
    if (!file?.buffer?.length) throw apiBadRequest("Choose a photo to upload", "POPULAR_PLACE_INVALID_IMAGE", { hint: POPULAR_IMAGE_RULE.hint });
    const place = await this.places.setImage(id, file, admin.userId);
    await this.record(admin, "popular_place.image", place, { image: place.image });
    return ok(place);
  }

  @Delete(":id/image")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Remove the place's photo (the apps show a placeholder)" })
  async removeImage(
    @Param("id", ParseObjectIdPipe) id: string,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<ApiSuccessBody<PopularPlaceAdminView>> {
    const place = await this.places.removeImage(id, admin.userId);
    await this.record(admin, "popular_place.image_remove", place);
    return ok(place);
  }

  private record(admin: AuthenticatedUser, action: string, place: PopularPlaceAdminView, metadata?: Record<string, unknown>) {
    return this.audit.record({
      adminId: admin.userId,
      action,
      targetType: "POPULAR_PLACE",
      targetId: place.id,
      targetLabel: place.name,
      ...(metadata ? { metadata } : {}),
    });
  }
}
