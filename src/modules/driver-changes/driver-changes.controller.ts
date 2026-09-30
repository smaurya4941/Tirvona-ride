import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { apiBadRequest } from "../../common/exceptions/api.exception";
import { ok } from "../../common/http/api-response";
import type { ApiSuccessBody } from "../../common/http/api-response";
import { documentUploadOptions, streamDocument } from "../../common/http/file-upload";
import { UploadCleanupInterceptor } from "../../common/interceptors/upload-cleanup.interceptor";
import { ParseObjectIdPipe } from "../../common/pipes/parse-object-id.pipe";
import type { AuthenticatedUser } from "../../common/types/jwt-payload";
import { UserRole } from "../../common/types/user-role.enum";
import { AuditLogService } from "../audit/audit-log.service";
import {
  AdminDriverChangeQueryDto,
  DocumentChangeDto,
  DriverChangeListQueryDto,
  DriverProfileChangeDto,
  RejectDriverChangeDto,
  VehicleChangeDto,
} from "./dto/driver-change.dto";
import { DriverChangesService } from "./driver-changes.service";
import type { AdminDriverChangeView, DriverChangeView, DriverChangesOverview } from "./driver-changes.service";
import type { Page } from "../rides/rides.service";

/**
 * Approved drivers asking to change verified details. Nothing here changes
 * the live profile, vehicle or documents — an admin review does.
 */
@ApiTags("Drivers · Changes after approval")
@ApiBearerAuth()
@Roles(UserRole.DRIVER)
@Controller({ path: "drivers/me/change-requests", version: "1" })
export class DriverChangesController {
  constructor(private readonly changes: DriverChangesService) {}

  @Get()
  @ApiOperation({ summary: "Pending changes and recent decisions" })
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: DriverChangeListQueryDto,
  ): Promise<ApiSuccessBody<DriverChangesOverview>> {
    return ok(await this.changes.overview(user.userId, query.status));
  }

  @Post("profile")
  @ApiOperation({ summary: "Ask to change licence number / expiry or date of birth" })
  async profile(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: DriverProfileChangeDto,
  ): Promise<ApiSuccessBody<DriverChangeView>> {
    return ok(await this.changes.requestProfileChange(user.userId, dto));
  }

  @Post("vehicle")
  @ApiOperation({ summary: "Ask to change the details of an active vehicle" })
  async vehicle(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: VehicleChangeDto,
  ): Promise<ApiSuccessBody<DriverChangeView>> {
    return ok(await this.changes.requestVehicleChange(user.userId, dto));
  }

  @Post("document")
  @ApiOperation({ summary: "Submit a new or renewed driver or vehicle document (multipart `file`)" })
  @ApiConsumes("multipart/form-data")
  @ApiBody({
    schema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["DRIVER", "VEHICLE"] },
        documentType: { type: "string" },
        vehicleId: { type: "string" },
        documentNumber: { type: "string" },
        expiryDate: { type: "string", format: "date" },
        file: { type: "string", format: "binary" },
      },
    },
  })
  @UseInterceptors(FileInterceptor("file", documentUploadOptions), UploadCleanupInterceptor)
  async document(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: DocumentChangeDto,
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<ApiSuccessBody<DriverChangeView>> {
    if (!file) throw apiBadRequest("A file is required", "DOCUMENT_INVALID_TYPE");
    return ok(await this.changes.requestDocumentChange(user.userId, dto, file));
  }

  @Get(":id/file")
  @ApiOperation({ summary: "The file submitted with a pending or approved document change" })
  async file(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseObjectIdPipe) id: string,
  ): Promise<StreamableFile> {
    return streamDocument(await this.changes.fileForDriver(user.userId, id));
  }

  @Delete(":id")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Withdraw a change that has not been reviewed yet" })
  async withdraw(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseObjectIdPipe) id: string,
  ): Promise<ApiSuccessBody<DriverChangeView>> {
    return ok(await this.changes.withdraw(user.userId, id));
  }
}

@ApiTags("Admin · Drivers")
@ApiBearerAuth()
@Roles(UserRole.ADMIN)
@Controller({ path: "admin/driver-change-requests", version: "1" })
export class AdminDriverChangesController {
  constructor(
    private readonly changes: DriverChangesService,
    private readonly audit: AuditLogService,
  ) {}

  @Get()
  @ApiOperation({ summary: "Driver change requests (the review queue by default: PENDING, oldest first)" })
  async list(@Query() query: AdminDriverChangeQueryDto): Promise<ApiSuccessBody<Page<AdminDriverChangeView>>> {
    return ok(await this.changes.listForAdmin(query));
  }

  @Get("summary")
  @ApiOperation({ summary: "How many changes wait for review" })
  async summary(): Promise<ApiSuccessBody<{ pending: number }>> {
    return ok({ pending: await this.changes.countPending() });
  }

  @Get(":id")
  @ApiOperation({ summary: "One change request with the verified values it would replace" })
  async get(@Param("id", ParseObjectIdPipe) id: string): Promise<ApiSuccessBody<AdminDriverChangeView>> {
    return ok(await this.changes.getForAdmin(id));
  }

  @Get(":id/file")
  @ApiOperation({ summary: "The uploaded document of a document change" })
  async file(@Param("id", ParseObjectIdPipe) id: string): Promise<StreamableFile> {
    return streamDocument(await this.changes.fileForAdmin(id));
  }

  @Post(":id/approve")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Approve and apply the change" })
  async approve(
    @CurrentUser() admin: AuthenticatedUser,
    @Param("id", ParseObjectIdPipe) id: string,
  ): Promise<ApiSuccessBody<AdminDriverChangeView>> {
    const view = await this.changes.approve(id, admin.userId);
    await this.audit.record({
      adminId: admin.userId,
      action: "driver_change.approve",
      targetType: "DRIVER",
      targetId: view.driver.id,
      targetLabel: `${view.driver.name} (${view.driver.driverCode}) · ${view.label}`,
      metadata: { changeRequestId: view.id, kind: view.kind, changes: view.changes },
    });
    return ok(view);
  }

  @Post(":id/reject")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Reject the change; the driver sees the reason" })
  async reject(
    @CurrentUser() admin: AuthenticatedUser,
    @Param("id", ParseObjectIdPipe) id: string,
    @Body() dto: RejectDriverChangeDto,
  ): Promise<ApiSuccessBody<AdminDriverChangeView>> {
    const view = await this.changes.reject(id, admin.userId, dto.reason);
    await this.audit.record({
      adminId: admin.userId,
      action: "driver_change.reject",
      targetType: "DRIVER",
      targetId: view.driver.id,
      targetLabel: `${view.driver.name} (${view.driver.driverCode}) · ${view.label}`,
      reason: dto.reason,
      metadata: { changeRequestId: view.id, kind: view.kind },
    });
    return ok(view);
  }
}
