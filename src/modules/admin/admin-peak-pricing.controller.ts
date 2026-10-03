import { Body, Controller, Delete, Get, Header, Param, Patch, Post } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { apiBadRequest } from "../../common/exceptions/api.exception";
import { ok } from "../../common/http/api-response";
import type { ApiSuccessBody } from "../../common/http/api-response";
import { ParseObjectIdPipe } from "../../common/pipes/parse-object-id.pipe";
import type { AuthenticatedUser } from "../../common/types/jwt-payload";
import { UserRole } from "../../common/types/user-role.enum";
import { AuditLogService } from "../audit/audit-log.service";
import { CreatePeakSlotDto, SetPeakSlotStatusDto, UpdatePeakSlotDto } from "../pricing/dto/peak-slot.dto";
import { effectivePerKmRate } from "../pricing/peak-pricing";
import { PeakPricingService, snapshotOf } from "../pricing/peak-pricing.service";
import type { PeakSlotSnapshot, PeakSlotView } from "../pricing/peak-pricing.service";
import { PricingService } from "../pricing/pricing.service";
import { RideTypesService } from "../ride-types/ride-types.service";

/** What is being charged per km right now for one ride type. */
export interface PeakStatusRow {
  rideType: string;
  displayName: string;
  isActive: boolean;
  /** False when the ride type has no tariff yet. */
  hasTariff: boolean;
  basePerKmRate?: number;
  /** The rate a trip started now would be charged at. */
  currentPerKmRate?: number;
  peak?: { slotId: string; name: string; hikePercent: number; startTime: string; endTime: string };
}

export interface PeakStatusView {
  timeZone: string;
  /** Server time the status was computed at. */
  now: Date;
  isPeak: boolean;
  rideTypes: PeakStatusRow[];
}

@ApiTags("Admin · Configuration")
@ApiBearerAuth()
@Roles(UserRole.ADMIN)
@Controller({ path: "admin/peak-pricing", version: "1" })
export class AdminPeakPricingController {
  constructor(
    private readonly peaks: PeakPricingService,
    private readonly pricing: PricingService,
    private readonly rideTypes: RideTypesService,
    private readonly audit: AuditLogService,
  ) {}

  @Get()
  @ApiOperation({ summary: "Every peak slot, enabled or not, with whether it is in force right now" })
  async list(): Promise<ApiSuccessBody<{ timeZone: string; items: PeakSlotView[] }>> {
    const now = new Date();
    const slots = await this.peaks.list();
    return ok({ timeZone: this.peaks.businessTimeZone, items: slots.map((slot) => this.peaks.toView(slot, now)) });
  }

  @Get("status")
  @Header("Cache-Control", "no-store")
  @ApiOperation({ summary: "Current pricing status: normal or peak, per ride type, from the server clock" })
  async status(): Promise<ApiSuccessBody<PeakStatusView>> {
    const now = new Date();
    const [rideTypes, tariffs] = await Promise.all([this.rideTypes.listAll(), this.pricing.listAll()]);
    const rows = await Promise.all(
      rideTypes.map(async (rideType): Promise<PeakStatusRow> => {
        const tariff = tariffs.find((entry) => entry.rideType === rideType.code);
        const base = { rideType: rideType.code, displayName: rideType.displayName, isActive: rideType.isActive };
        if (!tariff) return { ...base, hasTariff: false };
        const slot = await this.peaks.resolve(rideType.code, now);
        return {
          ...base,
          hasTariff: true,
          basePerKmRate: tariff.perKmRate,
          currentPerKmRate: slot ? effectivePerKmRate(tariff.perKmRate, slot.hikePercent) : tariff.perKmRate,
          peak: slot && {
            slotId: slot.id,
            name: slot.name,
            hikePercent: slot.hikePercent,
            startTime: slot.startTime,
            endTime: slot.endTime,
          },
        };
      }),
    );
    return ok({
      timeZone: this.peaks.businessTimeZone,
      now,
      isPeak: rows.some((row) => row.peak),
      rideTypes: rows,
    });
  }

  @Get(":id")
  @ApiOperation({ summary: "One peak slot" })
  async get(@Param("id", ParseObjectIdPipe) id: string): Promise<ApiSuccessBody<PeakSlotView>> {
    return ok(this.peaks.toView(await this.peaks.get(id)));
  }

  @Post()
  @ApiOperation({
    summary:
      "Create a peak slot: a daily window that raises the per-km rate by a percentage. Rejects overlaps for the same ride type.",
  })
  async create(
    @Body() dto: CreatePeakSlotDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<ApiSuccessBody<PeakSlotView>> {
    await this.assertRideTypesExist(dto.rideTypes);
    const slot = await this.peaks.create(dto, admin.userId);
    const view = this.peaks.toView(slot);
    await this.audit.record({
      adminId: admin.userId,
      action: "peak_slot.create",
      targetType: "PEAK_SLOT",
      targetId: view.id,
      targetLabel: view.name,
      metadata: { after: snapshotOf(view) },
    });
    return ok(view);
  }

  @Patch(":id")
  @ApiOperation({ summary: "Edit a peak slot. Affects new estimates and bookings only; booked rides keep their price." })
  async update(
    @Param("id", ParseObjectIdPipe) id: string,
    @Body() dto: UpdatePeakSlotDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<ApiSuccessBody<PeakSlotView>> {
    await this.assertRideTypesExist(dto.rideTypes);
    const { before, slot } = await this.peaks.update(id, dto, admin.userId);
    return ok(await this.audited(admin, "peak_slot.update", before, slot));
  }

  @Patch(":id/status")
  @ApiOperation({ summary: "Enable or disable a peak slot without deleting it" })
  async setStatus(
    @Param("id", ParseObjectIdPipe) id: string,
    @Body() dto: SetPeakSlotStatusDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<ApiSuccessBody<PeakSlotView>> {
    const { before, slot } = await this.peaks.setActive(id, dto.isActive, admin.userId);
    if (before.isActive === slot.isActive) return ok(this.peaks.toView(slot));
    return ok(await this.audited(admin, slot.isActive ? "peak_slot.enable" : "peak_slot.disable", before, slot));
  }

  @Delete(":id")
  @ApiOperation({ summary: "Delete a disabled peak slot. Booked rides keep the peak they were priced with." })
  async remove(
    @Param("id", ParseObjectIdPipe) id: string,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<ApiSuccessBody<{ deleted: true }>> {
    const before = await this.peaks.remove(id);
    await this.audit.record({
      adminId: admin.userId,
      action: "peak_slot.delete",
      targetType: "PEAK_SLOT",
      targetId: id,
      targetLabel: before.name,
      metadata: { before },
    });
    return ok({ deleted: true });
  }

  private async audited(
    admin: AuthenticatedUser,
    action: string,
    before: PeakSlotSnapshot,
    slot: Parameters<PeakPricingService["toView"]>[0],
  ): Promise<PeakSlotView> {
    const view = this.peaks.toView(slot);
    await this.audit.record({
      adminId: admin.userId,
      action,
      targetType: "PEAK_SLOT",
      targetId: view.id,
      targetLabel: view.name,
      metadata: { before, after: snapshotOf(view), version: view.version },
    });
    return view;
  }

  private async assertRideTypesExist(codes?: string[]): Promise<void> {
    for (const code of codes ?? []) {
      const known = await this.rideTypes.findByCode(code);
      if (!known) throw apiBadRequest(`Unknown ride type ${code}`, "PEAK_SLOT_INVALID");
    }
  }
}
