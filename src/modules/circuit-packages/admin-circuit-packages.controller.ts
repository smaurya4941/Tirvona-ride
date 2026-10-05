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
  Query,
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
import type { AutocompleteResult, ResolvedPlace } from "../places/places.types";
import { CIRCUIT_COVER_RULE, CircuitPackagesService } from "./circuit-packages.service";
import type { CircuitPackageAdminView, RoutePreviewView } from "./circuit-packages.service";
import {
  AdminPlaceResolveQueryDto,
  AdminPlaceSearchQueryDto,
  CreateCircuitPackageDto,
  ListCircuitPackagesQueryDto,
  RoutePreviewDto,
  SetCircuitPackageStatusDto,
  UpdateCircuitPackageDto,
} from "./dto/circuit-package.dto";

// Static segments (places/…) are declared before `:id` so Express never reads them as ids.
@ApiTags("Admin · Circuits")
@ApiBearerAuth()
@Roles(UserRole.ADMIN)
@Controller({ path: "admin/circuit-packages", version: "1" })
export class AdminCircuitPackagesController {
  constructor(private readonly packages: CircuitPackagesService) {}

  @Get("places/autocomplete")
  @ApiOperation({ summary: "Search places for a stop (same provider as the rider app)" })
  async searchPlaces(@Query() query: AdminPlaceSearchQueryDto): Promise<ApiSuccessBody<AutocompleteResult>> {
    return ok(await this.packages.placeSearch(query.q, query.sessionToken));
  }

  @Get("places/resolve")
  @ApiOperation({ summary: "Coordinates and address of a place picked from the search" })
  async resolvePlace(@Query() query: AdminPlaceResolveQueryDto): Promise<ApiSuccessBody<ResolvedPlace>> {
    return ok(await this.packages.placeResolve(query.id, query.sessionToken));
  }

  @Get("cover-rule")
  @ApiOperation({ summary: "What a cover image must be (the panel checks before uploading; the server re-checks the bytes)" })
  coverRule(): ApiSuccessBody<typeof CIRCUIT_COVER_RULE> {
    return ok(CIRCUIT_COVER_RULE);
  }

  @Get()
  @ApiOperation({ summary: "Every package, any status" })
  async list(@Query() query: ListCircuitPackagesQueryDto): Promise<ApiSuccessBody<CircuitPackageAdminView[]>> {
    return ok(await this.packages.list(query));
  }

  @Post()
  @ApiOperation({ summary: "Create a package as a DRAFT (incomplete drafts are allowed; publishing is validated)" })
  async create(
    @Body() dto: CreateCircuitPackageDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<ApiSuccessBody<CircuitPackageAdminView>> {
    return ok(await this.packages.create(dto, admin.userId));
  }

  @Get(":id")
  @ApiOperation({ summary: "One package with what still blocks publishing" })
  async findOne(@Param("id", ParseObjectIdPipe) id: string): Promise<ApiSuccessBody<CircuitPackageAdminView>> {
    return ok(await this.packages.getAdmin(id));
  }

  @Patch(":id")
  @ApiOperation({
    summary: "Edit a package. Existing bookings keep the terms they were booked on.",
    description: "Stops are replaced as a whole. A live package must stay publishable.",
  })
  async update(
    @Param("id", ParseObjectIdPipe) id: string,
    @Body() dto: UpdateCircuitPackageDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<ApiSuccessBody<CircuitPackageAdminView>> {
    return ok(await this.packages.update(id, dto, admin.userId));
  }

  @Patch(":id/status")
  @ApiOperation({ summary: "DRAFT → ACTIVE (runs every publishing rule), ACTIVE ⇄ INACTIVE, → ARCHIVED" })
  async setStatus(
    @Param("id", ParseObjectIdPipe) id: string,
    @Body() dto: SetCircuitPackageStatusDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<ApiSuccessBody<CircuitPackageAdminView>> {
    return ok(await this.packages.setStatus(id, dto.status, admin.userId, dto.reason));
  }

  @Post(":id/route-preview")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Stop → stop distance and time, with a warning when the included distance is too low" })
  async routePreview(
    @Param("id", ParseObjectIdPipe) id: string,
    @Body() dto: RoutePreviewDto,
  ): Promise<ApiSuccessBody<RoutePreviewView>> {
    return ok(await this.packages.routePreview(id, dto));
  }

  @Put(":id/cover")
  @ApiOperation({ summary: "Set or replace the cover image (multipart field `file`)" })
  @ApiConsumes("multipart/form-data")
  @ApiBody({ schema: { type: "object", properties: { file: { type: "string", format: "binary" } } } })
  @UseInterceptors(FileInterceptor("file", { storage: memoryStorage(), limits: { fileSize: CIRCUIT_COVER_RULE.maxBytes, files: 1 } }))
  async setCover(
    @Param("id", ParseObjectIdPipe) id: string,
    @CurrentUser() admin: AuthenticatedUser,
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<ApiSuccessBody<CircuitPackageAdminView>> {
    if (!file?.buffer?.length)
      throw apiBadRequest("Choose an image to upload", "CIRCUIT_PACKAGE_INVALID_IMAGE", { hint: CIRCUIT_COVER_RULE.hint });
    return ok(await this.packages.setCover(id, file, admin.userId));
  }

  @Delete(":id/cover")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Remove the cover image" })
  async removeCover(
    @Param("id", ParseObjectIdPipe) id: string,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<ApiSuccessBody<CircuitPackageAdminView>> {
    return ok(await this.packages.removeCover(id, admin.userId));
  }

  @Delete(":id")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Delete an unused draft (anything else is archived instead)" })
  async remove(
    @Param("id", ParseObjectIdPipe) id: string,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<ApiSuccessBody<{ deleted: true }>> {
    await this.packages.remove(id, admin.userId);
    return ok({ deleted: true });
  }
}
