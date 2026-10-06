import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import type { StreamableFile } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { AdminService } from "./admin.service";
import type {
  DashboardReport,
  DriverDetail,
  DriverListItem,
} from "./admin.service";
import { AdminPeopleService } from "./admin-people.service";
import type {
  CustomerDetail,
  CustomerListItem,
  VehicleListItem,
} from "./admin-people.service";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { ok } from "../../common/http/api-response";
import type { ApiSuccessBody } from "../../common/http/api-response";
import { StorageService } from "../storage/storage.service";
import { ParseObjectIdPipe } from "../../common/pipes/parse-object-id.pipe";
import type { AuthenticatedUser } from "../../common/types/jwt-payload";
import { UserRole } from "../../common/types/user-role.enum";
import { AuditLogService } from "../audit/audit-log.service";
import type { AuditLogView } from "../audit/audit-log.service";
import { TokenService } from "../auth/token.service";
import type { DriverSummary } from "../drivers/drivers.service";
import type { Page } from "../rides/rides.service";
import { AccountStatusService } from "../users/account-status.service";
import { UserStatus } from "../users/schemas/user.schema";
import {
  AdminCustomersQueryDto,
  AdminDriversQueryDto,
  AdminOptionalReasonDto,
  AdminReasonDto,
  AdminVehiclesQueryDto,
  AuditLogQueryDto,
} from "./dto/admin-people.dto";
import { RejectDriverDto } from "./dto/reject-driver.dto";
import { ReportQueryDto } from "../reports/dto/report-query.dto";

@ApiTags("Admin")
@ApiBearerAuth()
@Roles(UserRole.ADMIN)
@Controller({ path: "admin", version: "1" })
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly people: AdminPeopleService,
    private readonly audit: AuditLogService,
    private readonly tokens: TokenService,
    private readonly accounts: AccountStatusService,
    private readonly storage: StorageService,
  ) {}

  @Get("dashboard")
  @ApiOperation({
    summary:
      "Operational dashboard: KPIs for a period (preset or from/to, default today), live operations, trends",
  })
  async dashboard(
    @Query() query: ReportQueryDto,
  ): Promise<ApiSuccessBody<DashboardReport>> {
    return ok(await this.admin.dashboard(query));
  }

  // ── Drivers ───────────────────────────────────────────────────────────

  @Get("drivers")
  @ApiOperation({
    summary:
      "Drivers: filter by status/online, search code/name/phone, paginated",
  })
  async listDrivers(
    @Query() query: AdminDriversQueryDto,
  ): Promise<ApiSuccessBody<Page<DriverListItem>>> {
    return ok(await this.people.driverPage(query));
  }

  @Get("drivers/:id")
  @ApiOperation({ summary: "Full driver detail: profile, KYC docs, vehicles" })
  async getDriver(
    @Param("id", ParseObjectIdPipe) id: string,
  ): Promise<ApiSuccessBody<DriverDetail>> {
    return ok(await this.admin.getDriverDetail(id));
  }

  @Get("drivers/:id/documents/:documentId/file")
  @ApiOperation({ summary: "Download a driver's KYC document" })
  async driverDocumentFile(
    @Param("id", ParseObjectIdPipe) driverId: string,
    @Param("documentId", ParseObjectIdPipe) documentId: string,
  ): Promise<StreamableFile> {
    const document = await this.admin.getDriverDocumentFile(
      driverId,
      documentId,
    );
    return this.storage.stream(document.filePath);
  }

  @Get("vehicles/documents/:documentId/file")
  @ApiOperation({ summary: "Download a vehicle document" })
  async vehicleDocumentFile(
    @Param("documentId", ParseObjectIdPipe) documentId: string,
  ): Promise<StreamableFile> {
    const document = await this.admin.getVehicleDocumentFile(documentId);
    return this.storage.stream(document.filePath);
  }

  @Patch("drivers/:id/approve")
  @ApiOperation({ summary: "Approve a driver under review" })
  async approve(
    @Param("id", ParseObjectIdPipe) id: string,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<ApiSuccessBody<DriverSummary>> {
    const driver = await this.admin.approveDriver(id, admin.userId);
    await this.audit.record({
      adminId: admin.userId,
      action: "driver.approve",
      targetType: "DRIVER",
      targetId: id,
      targetLabel: driver.driverCode,
    });
    return ok(driver);
  }

  @Patch("drivers/:id/reject")
  @ApiOperation({ summary: "Reject a driver under review" })
  async reject(
    @Param("id", ParseObjectIdPipe) id: string,
    @Body() dto: RejectDriverDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<ApiSuccessBody<DriverSummary>> {
    const driver = await this.admin.rejectDriver(id, dto.reason);
    await this.audit.record({
      adminId: admin.userId,
      action: "driver.reject",
      targetType: "DRIVER",
      targetId: id,
      targetLabel: driver.driverCode,
      reason: dto.reason,
    });
    return ok(driver);
  }

  @Patch("drivers/:id/suspend")
  @ApiOperation({
    summary: "Suspend an approved driver (taken offline; cannot take rides)",
  })
  async suspend(
    @Param("id", ParseObjectIdPipe) id: string,
    @Body() dto: AdminReasonDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<ApiSuccessBody<DriverSummary>> {
    const driver = await this.admin.suspendDriver(id, admin.userId, dto.reason);
    await this.audit.record({
      adminId: admin.userId,
      action: "driver.suspend",
      targetType: "DRIVER",
      targetId: id,
      targetLabel: driver.driverCode,
      reason: dto.reason,
    });
    return ok(driver);
  }

  @Patch("drivers/:id/reinstate")
  @ApiOperation({ summary: "Reinstate a suspended driver" })
  async reinstate(
    @Param("id", ParseObjectIdPipe) id: string,
    @Body() dto: AdminOptionalReasonDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<ApiSuccessBody<DriverSummary>> {
    const driver = await this.admin.reinstateDriver(id);
    await this.audit.record({
      adminId: admin.userId,
      action: "driver.reinstate",
      targetType: "DRIVER",
      targetId: id,
      targetLabel: driver.driverCode,
      reason: dto.reason,
    });
    return ok(driver);
  }

  // ── Customers ─────────────────────────────────────────────────────────

  @Get("customers")
  @ApiOperation({
    summary: "Customers: search name/phone/email, filter by status, paginated",
  })
  async listCustomers(
    @Query() query: AdminCustomersQueryDto,
  ): Promise<ApiSuccessBody<Page<CustomerListItem>>> {
    return ok(await this.people.customerPage(query));
  }

  @Get("customers/:id")
  @ApiOperation({
    summary:
      "Customer profile, ride/payment stats, outstanding fees, recent rides",
  })
  async customer(
    @Param("id", ParseObjectIdPipe) id: string,
  ): Promise<ApiSuccessBody<CustomerDetail>> {
    return ok(await this.people.customerDetail(id));
  }

  @Post("customers/:id/block")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Block a customer: signed out everywhere, cannot book",
  })
  async block(
    @Param("id", ParseObjectIdPipe) id: string,
    @Body() dto: AdminReasonDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<ApiSuccessBody<CustomerDetail>> {
    const { customer, changed } = await this.people.setCustomerStatus(
      id,
      UserStatus.BLOCKED,
      admin.userId,
      dto.reason,
    );
    if (changed) {
      this.accounts.invalidate(id);
      await this.tokens.revokeAllForUser(id);
      await this.audit.record({
        adminId: admin.userId,
        action: "customer.block",
        targetType: "CUSTOMER",
        targetId: id,
        targetLabel: customer.phone,
        reason: dto.reason,
      });
    }
    return ok(await this.people.customerDetail(id));
  }

  @Post("customers/:id/unblock")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Unblock a customer" })
  async unblock(
    @Param("id", ParseObjectIdPipe) id: string,
    @Body() dto: AdminOptionalReasonDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<ApiSuccessBody<CustomerDetail>> {
    const { customer, changed } = await this.people.setCustomerStatus(
      id,
      UserStatus.ACTIVE,
      admin.userId,
      dto.reason,
    );
    if (changed) {
      this.accounts.invalidate(id);
      await this.audit.record({
        adminId: admin.userId,
        action: "customer.unblock",
        targetType: "CUSTOMER",
        targetId: id,
        targetLabel: customer.phone,
        reason: dto.reason,
      });
    }
    return ok(await this.people.customerDetail(id));
  }

  // ── Vehicles ──────────────────────────────────────────────────────────

  @Get("vehicles")
  @ApiOperation({
    summary:
      "Vehicles with their driver: filter by type/active, search registration",
  })
  async vehicles(
    @Query() query: AdminVehiclesQueryDto,
  ): Promise<ApiSuccessBody<Page<VehicleListItem>>> {
    return ok(await this.people.vehiclePage(query));
  }

  // ── Audit trail ───────────────────────────────────────────────────────

  @Get("audit-logs")
  @ApiOperation({
    summary: "High-impact admin actions: who, what, target, reason, when",
  })
  async auditLogs(
    @Query() query: AuditLogQueryDto,
  ): Promise<ApiSuccessBody<Page<AuditLogView>>> {
    return ok(await this.audit.list(query));
  }
}
