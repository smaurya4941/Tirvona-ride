import { Body, Controller, Get, Param, Patch, Query } from "@nestjs/common";
import type { StreamableFile } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { AdminService } from "./admin.service";
import type { DashboardReport, DriverDetail, DriverListItem } from "./admin.service";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { ok } from "../../common/http/api-response";
import type { ApiSuccessBody } from "../../common/http/api-response";
import { streamDocument } from "../../common/http/file-upload";
import type { AuthenticatedUser } from "../../common/types/jwt-payload";
import { UserRole } from "../../common/types/user-role.enum";
import type { DriverSummary } from "../drivers/drivers.service";
import { ListDriversQueryDto } from "./dto/list-drivers.query.dto";
import { RejectDriverDto } from "./dto/reject-driver.dto";

@ApiTags("Admin")
@ApiBearerAuth()
@Roles(UserRole.ADMIN)
@Controller({ path: "admin", version: "1" })
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get("dashboard")
  @ApiOperation({ summary: "Driver KYC pipeline counts" })
  async dashboard(): Promise<ApiSuccessBody<DashboardReport>> {
    return ok(await this.admin.dashboard());
  }

  @Get("drivers")
  @ApiOperation({ summary: "List drivers, optionally filtered by status" })
  async listDrivers(
    @Query() query: ListDriversQueryDto,
  ): Promise<ApiSuccessBody<DriverListItem[]>> {
    return ok(await this.admin.listDrivers(query.status));
  }

  @Get("drivers/:id")
  @ApiOperation({ summary: "Full driver detail: profile, KYC docs, vehicles" })
  async getDriver(@Param("id") id: string): Promise<ApiSuccessBody<DriverDetail>> {
    return ok(await this.admin.getDriverDetail(id));
  }

  @Get("drivers/:id/documents/:documentId/file")
  @ApiOperation({ summary: "Download a driver's KYC document" })
  async driverDocumentFile(
    @Param("id") driverId: string,
    @Param("documentId") documentId: string,
  ): Promise<StreamableFile> {
    const document = await this.admin.getDriverDocumentFile(driverId, documentId);
    return streamDocument(document.filePath);
  }

  @Get("vehicles/documents/:documentId/file")
  @ApiOperation({ summary: "Download a vehicle document" })
  async vehicleDocumentFile(
    @Param("documentId") documentId: string,
  ): Promise<StreamableFile> {
    const document = await this.admin.getVehicleDocumentFile(documentId);
    return streamDocument(document.filePath);
  }

  @Patch("drivers/:id/approve")
  @ApiOperation({ summary: "Approve a driver under review" })
  async approve(
    @Param("id") id: string,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<ApiSuccessBody<DriverSummary>> {
    return ok(await this.admin.approveDriver(id, admin.userId));
  }

  @Patch("drivers/:id/reject")
  @ApiOperation({ summary: "Reject a driver under review" })
  async reject(
    @Param("id") id: string,
    @Body() dto: RejectDriverDto,
  ): Promise<ApiSuccessBody<DriverSummary>> {
    return ok(await this.admin.rejectDriver(id, dto.reason));
  }
}
