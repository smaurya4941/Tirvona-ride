import {
  Body,
  Controller,
  Delete,
  Get,
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
import { apiBadRequest } from "../../common/exceptions/api.exception";
import { ok } from "../../common/http/api-response";
import type { ApiSuccessBody } from "../../common/http/api-response";
import {
  documentUploadOptions,
  streamDocument,
} from "../../common/http/file-upload";
import { UploadCleanupInterceptor } from "../../common/interceptors/upload-cleanup.interceptor";
import type { AuthenticatedUser } from "../../common/types/jwt-payload";
import { UserRole } from "../../common/types/user-role.enum";
import { CreateVehicleDto } from "./dto/create-vehicle.dto";
import { UpdateVehicleDto } from "./dto/update-vehicle.dto";
import { UploadVehicleDocumentDto } from "./dto/upload-vehicle-document.dto";
import type { VehicleDocumentDocument } from "./schemas/vehicle-document.schema";
import { VehiclesService } from "./vehicles.service";
import type { VehicleSummary } from "./vehicles.service";

function toDocumentSummary(document: VehicleDocumentDocument) {
  return {
    id: document._id.toString(),
    documentType: document.documentType,
    documentNumber: document.documentNumber,
    status: document.status,
    expiryDate: document.expiryDate,
    verifiedAt: document.verifiedAt,
    createdAt: document.get("createdAt") as Date,
  };
}

@ApiTags("Vehicles")
@ApiBearerAuth()
@Roles(UserRole.DRIVER)
@Controller({ path: "vehicles", version: "1" })
export class VehiclesController {
  constructor(private readonly vehicles: VehiclesService) {}

  @Post()
  @ApiOperation({ summary: "Register a vehicle for the authenticated driver" })
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateVehicleDto,
  ): Promise<ApiSuccessBody<VehicleSummary>> {
    const vehicle = await this.vehicles.create(user.userId, dto);
    return ok(this.vehicles.toSummary(vehicle));
  }

  @Get("my")
  @ApiOperation({ summary: "List the authenticated driver's vehicles" })
  async findMine(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ApiSuccessBody<VehicleSummary[]>> {
    const vehicles = await this.vehicles.findMine(user.userId);
    return ok(vehicles.map((vehicle) => this.vehicles.toSummary(vehicle)));
  }

  @Get(":id")
  @ApiOperation({ summary: "Get one of the authenticated driver's vehicles" })
  async findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
  ): Promise<ApiSuccessBody<VehicleSummary>> {
    const vehicle = await this.vehicles.findOneOwned(user.userId, id);
    return ok(this.vehicles.toSummary(vehicle));
  }

  @Patch(":id")
  @ApiOperation({ summary: "Update a vehicle" })
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body() dto: UpdateVehicleDto,
  ): Promise<ApiSuccessBody<VehicleSummary>> {
    const vehicle = await this.vehicles.update(user.userId, id, dto);
    return ok(this.vehicles.toSummary(vehicle));
  }

  @Delete(":id")
  @ApiOperation({ summary: "Deactivate a vehicle (soft delete)" })
  async deactivate(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
  ): Promise<ApiSuccessBody<{ deactivated: true }>> {
    await this.vehicles.deactivate(user.userId, id);
    return ok({ deactivated: true });
  }

  @Post(":id/documents")
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
  @ApiOperation({ summary: "Upload (or replace) a vehicle document" })
  @UseInterceptors(
    FileInterceptor("file", documentUploadOptions),
    UploadCleanupInterceptor,
  )
  async uploadDocument(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body() dto: UploadVehicleDocumentDto,
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<ApiSuccessBody<ReturnType<typeof toDocumentSummary>>> {
    if (!file)
      throw apiBadRequest("A file is required", "DOCUMENT_INVALID_TYPE");
    const document = await this.vehicles.addDocument(user.userId, id, dto, file);
    return ok(toDocumentSummary(document));
  }

  @Get(":id/documents")
  @ApiOperation({ summary: "List a vehicle's documents" })
  async listDocuments(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
  ): Promise<ApiSuccessBody<ReturnType<typeof toDocumentSummary>[]>> {
    const documents = await this.vehicles.listDocuments(user.userId, id);
    return ok(documents.map(toDocumentSummary));
  }

  @Get(":id/documents/:documentId/file")
  @ApiOperation({ summary: "Download a vehicle document" })
  async downloadDocument(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Param("documentId") documentId: string,
  ): Promise<StreamableFile> {
    const document = await this.vehicles.getDocumentForOwner(
      user.userId,
      id,
      documentId,
    );
    return streamDocument(document.filePath);
  }
}
