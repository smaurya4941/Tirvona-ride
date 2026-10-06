import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseEnumPipe,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
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
import { CancellationsService } from "../cancellations/cancellations.service";
import type {
  CancellationPolicyView,
  CancellationReasonView,
  CancellationView,
} from "../cancellations/cancellations.service";
import {
  CreateCancellationReasonDto,
  ListCancellationsQueryDto,
  ResolveCancellationFeeDto,
  UpdateCancellationPolicyDto,
  UpdateCancellationReasonDto,
} from "../cancellations/dto/cancellation.dto";
import {
  AudienceQueryDto,
  CreateBroadcastDto,
  ListBroadcastsQueryDto,
  UpdateBroadcastDto,
} from "../notifications/broadcasts/broadcast.dto";
import { BroadcastsService } from "../notifications/broadcasts/broadcasts.service";
import type { BroadcastView } from "../notifications/broadcasts/broadcasts.service";
import {
  CreatePromoDto,
  ListPromosQueryDto,
  PromoStatusDto,
  UpdatePromoDto,
} from "../promotions/dto/promo.dto";
import { PromoStatus } from "../promotions/promo-rules";
import { PromotionsService } from "../promotions/promotions.service";
import type {
  PromoRedemptionView,
  PromoView,
} from "../promotions/promotions.service";
import { RideActorType } from "../rides/ride-state-machine";
import type { Page } from "../rides/rides.service";
import {
  CreateZoneDto,
  ListZonesQueryDto,
  UpdateZoneDto,
  ZoneLookupQueryDto,
  ZoneStatusDto,
} from "../zones/dto/zone.dto";
import { ZoneStatus } from "../zones/schemas/zone.schema";
import { ZonesService } from "../zones/zones.service";
import type { ServiceAreaCheck, ZoneView } from "../zones/zones.service";

// ── Zones ──────────────────────────────────────────────────────────────

@ApiTags("Admin · Configuration")
@ApiBearerAuth()
@Roles(UserRole.ADMIN)
@Controller({ path: "admin/zones", version: "1" })
export class AdminZonesController {
  constructor(
    private readonly zones: ZonesService,
    private readonly audit: AuditLogService,
  ) {}

  @Get()
  @ApiOperation({ summary: "Service zones (search, status, paginated)" })
  async list(
    @Query() query: ListZonesQueryDto,
  ): Promise<ApiSuccessBody<Page<ZoneView>>> {
    return ok(await this.zones.list(query));
  }

  @Get("lookup")
  @ApiOperation({
    summary: "Which active zone contains a point, and is it serviceable?",
  })
  async lookup(
    @Query() query: ZoneLookupQueryDto,
  ): Promise<ApiSuccessBody<ServiceAreaCheck>> {
    return ok(await this.zones.checkServiceArea(query));
  }

  @Get(":id")
  @ApiOperation({ summary: "One zone with its boundary" })
  async get(
    @Param("id", ParseObjectIdPipe) id: string,
  ): Promise<ApiSuccessBody<ZoneView>> {
    return ok(this.zones.toView(await this.zones.get(id)));
  }

  @Post()
  @ApiOperation({
    summary: "Create a zone from boundary points (validated polygon)",
  })
  async create(
    @Body() dto: CreateZoneDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<ApiSuccessBody<ZoneView>> {
    const zone = await this.zones.create(dto, admin.userId);
    await this.audit.record({
      adminId: admin.userId,
      action: "zone.create",
      targetType: "ZONE",
      targetId: zone._id.toString(),
      targetLabel: zone.name,
      metadata: { status: zone.status, vertices: dto.boundary.length },
    });
    return ok(this.zones.toView(zone));
  }

  @Patch(":id")
  @ApiOperation({ summary: "Edit name, city, description or boundary" })
  async update(
    @Param("id", ParseObjectIdPipe) id: string,
    @Body() dto: UpdateZoneDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<ApiSuccessBody<ZoneView>> {
    const zone = await this.zones.update(id, dto, admin.userId);
    await this.audit.record({
      adminId: admin.userId,
      action: "zone.update",
      targetType: "ZONE",
      targetId: id,
      targetLabel: zone.name,
      metadata: { fields: Object.keys(dto) },
    });
    return ok(this.zones.toView(zone));
  }

  @Patch(":id/status")
  @ApiOperation({ summary: "Activate or deactivate a zone" })
  async setStatus(
    @Param("id", ParseObjectIdPipe) id: string,
    @Body() dto: ZoneStatusDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<ApiSuccessBody<ZoneView>> {
    if (dto.status === ZoneStatus.INACTIVE && !dto.reason)
      throw apiBadRequest(
        "Give a reason for deactivating this zone",
        "VALIDATION_FAILED",
      );
    const { zone, changed } = await this.zones.setStatus(
      id,
      dto.status,
      admin.userId,
    );
    if (changed)
      await this.audit.record({
        adminId: admin.userId,
        action:
          dto.status === ZoneStatus.ACTIVE
            ? "zone.activate"
            : "zone.deactivate",
        targetType: "ZONE",
        targetId: id,
        targetLabel: zone.name,
        reason: dto.reason,
      });
    return ok(this.zones.toView(zone));
  }
}

// ── Promotions ─────────────────────────────────────────────────────────

@ApiTags("Admin · Growth")
@ApiBearerAuth()
@Roles(UserRole.ADMIN)
@Controller({ path: "admin/promotions", version: "1" })
export class AdminPromotionsController {
  constructor(
    private readonly promotions: PromotionsService,
    private readonly audit: AuditLogService,
  ) {}

  @Get()
  @ApiOperation({
    summary: "Promo codes (search code/title, status, live/scheduled/expired)",
  })
  async list(
    @Query() query: ListPromosQueryDto,
  ): Promise<ApiSuccessBody<Page<PromoView>>> {
    return ok(await this.promotions.list(query));
  }

  @Get(":id")
  @ApiOperation({ summary: "One promo with its recent redemptions" })
  async get(
    @Param("id", ParseObjectIdPipe) id: string,
  ): Promise<
    ApiSuccessBody<{ promo: PromoView; redemptions: PromoRedemptionView[] }>
  > {
    const promo = await this.promotions.get(id);
    return ok({
      promo: this.promotions.toView(promo),
      redemptions: await this.promotions.recentRedemptions(promo._id),
    });
  }

  @Post()
  @ApiOperation({ summary: "Create a promo code" })
  async create(
    @Body() dto: CreatePromoDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<ApiSuccessBody<PromoView>> {
    const promo = await this.promotions.create(dto, admin.userId);
    await this.audit.record({
      adminId: admin.userId,
      action: "promo.create",
      targetType: "PROMO",
      targetId: promo._id.toString(),
      targetLabel: promo.code,
      metadata: {
        discountType: promo.discountType,
        discountValue: promo.discountValue,
        usageLimit: promo.usageLimit,
      },
    });
    return ok(this.promotions.toView(promo));
  }

  @Patch(":id")
  @ApiOperation({ summary: "Edit a promo (the code itself is fixed)" })
  async update(
    @Param("id", ParseObjectIdPipe) id: string,
    @Body() dto: UpdatePromoDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<ApiSuccessBody<PromoView>> {
    const promo = await this.promotions.update(id, dto, admin.userId);
    await this.audit.record({
      adminId: admin.userId,
      action: "promo.update",
      targetType: "PROMO",
      targetId: id,
      targetLabel: promo.code,
      metadata: { changes: { ...dto } },
    });
    return ok(this.promotions.toView(promo));
  }

  @Patch(":id/status")
  @ApiOperation({
    summary:
      "Activate or deactivate a promo (bookings already made keep their discount)",
  })
  async setStatus(
    @Param("id", ParseObjectIdPipe) id: string,
    @Body() dto: PromoStatusDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<ApiSuccessBody<PromoView>> {
    if (dto.status === PromoStatus.INACTIVE && !dto.reason)
      throw apiBadRequest(
        "Give a reason for deactivating this promo",
        "VALIDATION_FAILED",
      );
    const { promo, changed } = await this.promotions.setStatus(
      id,
      dto.status,
      admin.userId,
    );
    if (changed)
      await this.audit.record({
        adminId: admin.userId,
        action:
          dto.status === PromoStatus.ACTIVE
            ? "promo.activate"
            : "promo.deactivate",
        targetType: "PROMO",
        targetId: id,
        targetLabel: promo.code,
        reason: dto.reason,
      });
    return ok(this.promotions.toView(promo));
  }
}

// ── Cancellations ──────────────────────────────────────────────────────

const actorParam = new ParseEnumPipe([
  RideActorType.CUSTOMER,
  RideActorType.DRIVER,
  RideActorType.ADMIN,
]);

@ApiTags("Admin · Cancellations")
@ApiBearerAuth()
@Roles(UserRole.ADMIN)
@Controller({ path: "admin/cancellations", version: "1" })
export class AdminCancellationsController {
  constructor(
    private readonly cancellations: CancellationsService,
    private readonly audit: AuditLogService,
  ) {}

  @Get()
  @ApiOperation({
    summary:
      "Cancellation records (actor, reason, fee status, date range, ride code)",
  })
  async list(
    @Query() query: ListCancellationsQueryDto,
  ): Promise<ApiSuccessBody<Page<CancellationView>>> {
    return ok(await this.cancellations.list(query));
  }

  @Get("reasons")
  @ApiOperation({ summary: "Every cancellation reason, active and retired" })
  async reasons(): Promise<ApiSuccessBody<CancellationReasonView[]>> {
    return ok(await this.cancellations.listReasons(undefined, false));
  }

  @Post("reasons")
  @ApiOperation({ summary: "Add a cancellation reason" })
  async createReason(
    @Body() dto: CreateCancellationReasonDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<ApiSuccessBody<CancellationReasonView>> {
    const reason = await this.cancellations.createReason(dto);
    await this.audit.record({
      adminId: admin.userId,
      action: "cancellation_reason.create",
      targetType: "CANCELLATION_REASON",
      targetId: `${reason.actor}:${reason.code}`,
      targetLabel: reason.label,
    });
    return ok(reason);
  }

  @Patch("reasons/:actor/:code")
  @ApiOperation({
    summary:
      "Relabel, reorder, retire or restore a reason (codes never change)",
  })
  async updateReason(
    @Param("actor", actorParam) actor: RideActorType,
    @Param("code") code: string,
    @Body() dto: UpdateCancellationReasonDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<ApiSuccessBody<CancellationReasonView>> {
    if (!/^[A-Z][A-Z0-9_]{1,39}$/.test(code))
      throw apiBadRequest("Invalid reason code", "VALIDATION_FAILED");
    const reason = await this.cancellations.updateReason(actor, code, dto);
    await this.audit.record({
      adminId: admin.userId,
      action: "cancellation_reason.update",
      targetType: "CANCELLATION_REASON",
      targetId: `${actor}:${code}`,
      targetLabel: reason.label,
      metadata: { changes: { ...dto } },
    });
    return ok(reason);
  }

  @Get("policy")
  @ApiOperation({
    summary: "The cancellation-fee policy in force, and its history",
  })
  async policy(): Promise<
    ApiSuccessBody<{
      current: CancellationPolicyView;
      history: CancellationPolicyView[];
    }>
  > {
    const [current, history] = await Promise.all([
      this.cancellations.currentPolicy(),
      this.cancellations.policyHistory(),
    ]);
    return ok({ current, history });
  }

  @Patch("policy")
  @ApiOperation({
    summary:
      "Set a new fee policy version (applies to cancellations from now on)",
  })
  async updatePolicy(
    @Body() dto: UpdateCancellationPolicyDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<ApiSuccessBody<CancellationPolicyView>> {
    const policy = await this.cancellations.updatePolicy(dto, admin.userId);
    await this.audit.record({
      adminId: admin.userId,
      action: "cancellation_policy.update",
      targetType: "CANCELLATION_POLICY",
      targetId: String(policy.version),
      targetLabel: `v${policy.version}`,
      reason: dto.note,
      metadata: { customerFee: { ...dto.customerFee } },
    });
    return ok(policy);
  }

  @Post(":id/fee")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Waive a due cancellation fee, or mark it collected",
  })
  async resolveFee(
    @Param("id", ParseObjectIdPipe) id: string,
    @Body() dto: ResolveCancellationFeeDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<ApiSuccessBody<CancellationView>> {
    const cancellation = await this.cancellations.resolveFee(
      id,
      dto.status,
      dto.note,
      admin.userId,
    );
    await this.audit.record({
      adminId: admin.userId,
      action:
        dto.status === "WAIVED"
          ? "cancellation_fee.waive"
          : "cancellation_fee.collect",
      targetType: "CANCELLATION",
      targetId: id,
      targetLabel: cancellation.rideCode,
      reason: dto.note,
      metadata: { amount: cancellation.feeAmount },
    });
    return ok(cancellation);
  }
}

// ── Broadcasts ─────────────────────────────────────────────────────────

@ApiTags("Admin · Communication")
@ApiBearerAuth()
@Roles(UserRole.ADMIN)
@Controller({ path: "admin/broadcasts", version: "1" })
export class AdminBroadcastsController {
  constructor(
    private readonly broadcasts: BroadcastsService,
    private readonly audit: AuditLogService,
  ) {}

  @Get()
  @ApiOperation({
    summary: "Broadcasts: drafts, scheduled, sending, sent (history)",
  })
  async list(
    @Query() query: ListBroadcastsQueryDto,
  ): Promise<ApiSuccessBody<Page<BroadcastView>>> {
    return ok(await this.broadcasts.list(query));
  }

  @Get("audience")
  @ApiOperation({ summary: "How many accounts an audience reaches right now" })
  async audience(
    @Query() query: AudienceQueryDto,
  ): Promise<ApiSuccessBody<{ audience: string; recipients: number }>> {
    return ok({
      audience: query.audience,
      recipients: await this.broadcasts.audienceSize(query.audience),
    });
  }

  @Get(":id")
  @ApiOperation({ summary: "One broadcast" })
  async get(
    @Param("id", ParseObjectIdPipe) id: string,
  ): Promise<ApiSuccessBody<BroadcastView>> {
    return ok(this.broadcasts.toView(await this.broadcasts.get(id)));
  }

  @Post()
  @ApiOperation({ summary: "Create a draft (or schedule it with scheduledAt)" })
  async create(
    @Body() dto: CreateBroadcastDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<ApiSuccessBody<BroadcastView>> {
    const broadcast = await this.broadcasts.create(dto, admin.userId);
    if (broadcast.scheduledAt)
      await this.audit.record({
        adminId: admin.userId,
        action: "broadcast.schedule",
        targetType: "BROADCAST",
        targetId: broadcast._id.toString(),
        targetLabel: broadcast.title,
        metadata: {
          audience: broadcast.audience,
          scheduledAt: broadcast.scheduledAt,
        },
      });
    return ok(this.broadcasts.toView(broadcast));
  }

  @Patch(":id")
  @ApiOperation({ summary: "Edit a draft or scheduled broadcast" })
  async update(
    @Param("id", ParseObjectIdPipe) id: string,
    @Body() dto: UpdateBroadcastDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<ApiSuccessBody<BroadcastView>> {
    return ok(
      this.broadcasts.toView(
        await this.broadcasts.update(id, dto, admin.userId),
      ),
    );
  }

  @Post(":id/send")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Send now (confirmed in the panel). Delivery continues in the background.",
  })
  async send(
    @Param("id", ParseObjectIdPipe) id: string,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<ApiSuccessBody<BroadcastView>> {
    const broadcast = await this.broadcasts.sendNow(id, admin.userId);
    await this.audit.record({
      adminId: admin.userId,
      action: "broadcast.send",
      targetType: "BROADCAST",
      targetId: id,
      targetLabel: broadcast.title,
      metadata: { audience: broadcast.audience },
    });
    return ok(this.broadcasts.toView(broadcast));
  }

  @Post(":id/cancel")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Cancel a draft or scheduled broadcast" })
  async cancel(
    @Param("id", ParseObjectIdPipe) id: string,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<ApiSuccessBody<BroadcastView>> {
    const broadcast = await this.broadcasts.cancel(id, admin.userId);
    await this.audit.record({
      adminId: admin.userId,
      action: "broadcast.cancel",
      targetType: "BROADCAST",
      targetId: id,
      targetLabel: broadcast.title,
    });
    return ok(this.broadcasts.toView(broadcast));
  }
}
