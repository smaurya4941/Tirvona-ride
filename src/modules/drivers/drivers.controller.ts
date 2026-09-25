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
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import {
  documentUploadOptions,
  streamDocument,
} from "../../common/http/file-upload";
import { ok } from "../../common/http/api-response";
import type { ApiSuccessBody } from "../../common/http/api-response";
import { apiBadRequest } from "../../common/exceptions/api.exception";
import { UploadCleanupInterceptor } from "../../common/interceptors/upload-cleanup.interceptor";
import type { AuthenticatedUser } from "../../common/types/jwt-payload";
import { UserRole } from "../../common/types/user-role.enum";
import { DriversService } from "./drivers.service";
import type { DriverSummary } from "./drivers.service";
import { UpdateDriverProfileDto } from "./dto/update-driver-profile.dto";
import { UploadDriverDocumentDto } from "./dto/upload-driver-document.dto";
import type { DriverDocumentDocument } from "./schemas/driver-document.schema";

function toDocumentSummary(document: DriverDocumentDocument) {
  return {
    id: document._id.toString(),
    documentType: document.documentType,
    documentNumber: document.documentNumber,
    status: document.status,
    rejectionReason: document.rejectionReason,
    expiryDate: document.expiryDate,
    verifiedAt: document.verifiedAt,
    createdAt: document.get("createdAt") as Date,
  };
}

@ApiTags("Drivers")
@ApiBearerAuth()
@Roles(UserRole.DRIVER)
@Controller({ path: "drivers", version: "1" })
export class DriversController {
  constructor(private readonly drivers: DriversService) {}

  @Get("me")
  @ApiOperation({ summary: "Get the authenticated driver's profile" })
  async me(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ApiSuccessBody<DriverSummary>> {
    const driver = await this.drivers.getByUserId(user.userId);
    return ok(this.drivers.toSummary(driver));
  }

  @Patch("me")
  @ApiOperation({ summary: "Update license and address details" })
  async updateMe(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateDriverProfileDto,
  ): Promise<ApiSuccessBody<DriverSummary>> {
    const driver = await this.drivers.updateProfile(user.userId, dto);
    return ok(this.drivers.toSummary(driver));
  }

  @Post("me/documents")
  @ApiConsumes("multipart/form-data")
  @ApiBody({
    schema: {
      type: "object",
      properties: {
        documentType: { type: "string" },
        documentNumber: { type: "string" },
        file: { type: "string", format: "binary" },
      },
    },
  })
  @ApiOperation({ summary: "Upload (or replace) a KYC document" })
  @UseInterceptors(
    FileInterceptor("file", documentUploadOptions),
    UploadCleanupInterceptor,
  )
  async uploadDocument(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UploadDriverDocumentDto,
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<ApiSuccessBody<ReturnType<typeof toDocumentSummary>>> {
    if (!file)
      throw apiBadRequest("A file is required", "DOCUMENT_INVALID_TYPE");
    const document = await this.drivers.addDocument(user.userId, dto, file);
    return ok(toDocumentSummary(document));
  }

  @Get("me/documents")
  @ApiOperation({ summary: "List the authenticated driver's KYC documents" })
  async listDocuments(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ApiSuccessBody<ReturnType<typeof toDocumentSummary>[]>> {
    const documents = await this.drivers.listDocuments(user.userId);
    return ok(documents.map(toDocumentSummary));
  }

  @Get("me/documents/:id/file")
  @ApiOperation({ summary: "Download a previously uploaded KYC document" })
  async downloadDocument(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") documentId: string,
  ): Promise<StreamableFile> {
    const document = await this.drivers.getDocumentForOwner(
      user.userId,
      documentId,
    );
    return streamDocument(document.filePath);
  }

  @Delete("me/documents/:id")
  @ApiOperation({ summary: "Remove a pending KYC document" })
  async deleteDocument(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") documentId: string,
  ): Promise<ApiSuccessBody<{ deleted: true }>> {
    await this.drivers.deleteDocument(user.userId, documentId);
    return ok({ deleted: true });
  }

  @Post("me/submit-kyc")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Submit KYC for admin review" })
  async submitKyc(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ApiSuccessBody<DriverSummary>> {
    const driver = await this.drivers.submitKyc(user.userId);
    return ok(this.drivers.toSummary(driver));
  }
}
