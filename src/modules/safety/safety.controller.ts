import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Res } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { Response } from "express";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Public } from "../../common/decorators/public.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { ok } from "../../common/http/api-response";
import type { ApiSuccessBody } from "../../common/http/api-response";
import { ParseObjectIdPipe } from "../../common/pipes/parse-object-id.pipe";
import type { AuthenticatedUser } from "../../common/types/jwt-payload";
import { UserRole } from "../../common/types/user-role.enum";
import { CreateEmergencyContactDto, UpdateEmergencyContactDto } from "./dto/emergency-contact.dto";
import { TriggerSosDto } from "./dto/sos.dto";
import { EmergencyContactsService } from "./emergency-contacts.service";
import type { EmergencyContactView } from "./emergency-contacts.service";
import { ShareRideService } from "./share-ride.service";
import type { ShareLinkView } from "./share-ride.service";
import { renderShareErrorPage, renderSharedRidePage } from "./share-ride-page";
import type { SharedRideView } from "./share-ride-view";
import { SosService } from "./sos.service";
import type { SosTriggerResult, SosView } from "./sos.service";

@ApiTags("Safety")
@ApiBearerAuth()
@Roles(UserRole.CUSTOMER, UserRole.DRIVER)
@Controller({ path: "users/me/emergency-contacts", version: "1" })
export class EmergencyContactsController {
  constructor(private readonly contacts: EmergencyContactsService) {}

  @Get()
  @ApiOperation({ summary: "The caller's emergency contacts (primary first)" })
  async list(@CurrentUser() user: AuthenticatedUser): Promise<ApiSuccessBody<EmergencyContactView[]>> {
    return ok(await this.contacts.list(user.userId));
  }

  @Post()
  @ApiOperation({ summary: "Add an emergency contact (the first one becomes primary)" })
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateEmergencyContactDto,
  ): Promise<ApiSuccessBody<EmergencyContactView>> {
    return ok(await this.contacts.create(user.userId, dto));
  }

  @Patch(":id")
  @ApiOperation({ summary: "Edit an emergency contact, or make it primary" })
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseObjectIdPipe) id: string,
    @Body() dto: UpdateEmergencyContactDto,
  ): Promise<ApiSuccessBody<EmergencyContactView>> {
    return ok(await this.contacts.update(user.userId, id, dto));
  }

  @Delete(":id")
  @ApiOperation({ summary: "Remove an emergency contact" })
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseObjectIdPipe) id: string,
  ): Promise<ApiSuccessBody<{ deleted: true }>> {
    await this.contacts.remove(user.userId, id);
    return ok({ deleted: true });
  }
}

@ApiTags("Safety")
@ApiBearerAuth()
@Controller({ path: "rides", version: "1" })
export class RideSafetyController {
  constructor(
    private readonly sos: SosService,
    private readonly share: ShareRideService,
  ) {}

  @Post(":id/sos")
  @Roles(UserRole.CUSTOMER, UserRole.DRIVER)
  // Generous: a person in danger may press repeatedly; repeats update one incident.
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: "Raise an SOS on a ride you are part of (alerts the safety team)" })
  async triggerSos(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseObjectIdPipe) id: string,
    @Body() dto: TriggerSosDto,
  ): Promise<ApiSuccessBody<SosTriggerResult>> {
    return ok(await this.sos.trigger(user, id, dto));
  }

  @Get(":id/sos")
  @Roles(UserRole.CUSTOMER, UserRole.DRIVER)
  @ApiOperation({ summary: "Your SOS alerts on this ride and their status" })
  async listSos(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseObjectIdPipe) id: string,
  ): Promise<ApiSuccessBody<SosView[]>> {
    return ok(await this.sos.listForRide(user, id));
  }

  @Post(":id/share")
  @Roles(UserRole.CUSTOMER)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: "Create a public read-only link to this ride's live status" })
  async createShare(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseObjectIdPipe) id: string,
  ): Promise<ApiSuccessBody<ShareLinkView>> {
    return ok(await this.share.create(user.userId, id));
  }

  @Get(":id/share")
  @Roles(UserRole.CUSTOMER)
  @ApiOperation({ summary: "How many share links of this ride are live" })
  async shareStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseObjectIdPipe) id: string,
  ): Promise<ApiSuccessBody<{ active: number }>> {
    return ok(await this.share.activeLinkCount(user.userId, id));
  }

  @Delete(":id/share")
  @Roles(UserRole.CUSTOMER)
  @ApiOperation({ summary: "Stop sharing: every link of this ride stops working" })
  async revokeShare(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseObjectIdPipe) id: string,
  ): Promise<ApiSuccessBody<{ revoked: number }>> {
    return ok(await this.share.revoke(user.userId, id));
  }
}

/** Public, read-only. No login; only sanitized ride information. */
@ApiTags("Safety")
@Public()
@Throttle({ default: { limit: 60, ttl: 60_000 } })
@Controller({ path: "shared-rides", version: "1" })
export class SharedRidesController {
  private readonly timeZone: string;

  constructor(
    private readonly share: ShareRideService,
    config: ConfigService,
  ) {
    this.timeZone = config.getOrThrow<string>("appTimeZone");
  }

  // Declared before ":token" so "view" is never read as a token.
  @Get("view/:token")
  @ApiOperation({ summary: "The share link's page (HTML)" })
  async page(@Param("token") token: string, @Res({ passthrough: true }) response: Response): Promise<string> {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    this.privateHeaders(response);
    try {
      return renderSharedRidePage(await this.share.publicView(token), this.timeZone);
    } catch (error) {
      const status = (error as { getStatus?: () => number }).getStatus?.();
      if (status !== HttpStatus.NOT_FOUND && status !== HttpStatus.GONE) throw error;
      response.status(status);
      return renderShareErrorPage(status === HttpStatus.GONE);
    }
  }

  @Get(":token")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Sanitized live status for a share token (JSON)" })
  async status(
    @Param("token") token: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ApiSuccessBody<SharedRideView>> {
    this.privateHeaders(response);
    return ok(await this.share.publicView(token));
  }

  private privateHeaders(response: Response): void {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Robots-Tag", "noindex, nofollow");
    response.setHeader("Referrer-Policy", "no-referrer");
  }
}
