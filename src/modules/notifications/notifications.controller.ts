import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { ok } from "../../common/http/api-response";
import type { ApiSuccessBody } from "../../common/http/api-response";
import { ParseObjectIdPipe } from "../../common/pipes/parse-object-id.pipe";
import type { AuthenticatedUser } from "../../common/types/jwt-payload";
import { DeviceTokensService } from "./device-tokens.service";
import type { DeviceTokenView } from "./device-tokens.service";
import { DeactivateDeviceTokenDto, ListNotificationsQueryDto, RegisterDeviceTokenDto } from "./dto/notification.dto";
import { NotificationsService } from "./notifications.service";
import type { NotificationPage, NotificationView } from "./notifications.service";

// Every route is scoped to the caller (customer, driver or admin): the user
// id always comes from the access token, never from the request.
@ApiTags("Notifications")
@ApiBearerAuth()
@Controller({ path: "notifications", version: "1" })
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly deviceTokens: DeviceTokensService,
  ) {}

  @Get()
  @ApiOperation({ summary: "The caller's notifications, newest first (page/limit), with the unread count" })
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListNotificationsQueryDto,
  ): Promise<ApiSuccessBody<NotificationPage>> {
    return ok(await this.notifications.list(user.userId, query));
  }

  @Get("unread-count")
  @ApiOperation({ summary: "Unread notification count (badge)" })
  async unreadCount(@CurrentUser() user: AuthenticatedUser): Promise<ApiSuccessBody<{ unreadCount: number }>> {
    return ok({ unreadCount: await this.notifications.unreadCount(user.userId) });
  }

  @Patch("read-all")
  @ApiOperation({ summary: "Mark every notification as read" })
  async readAll(@CurrentUser() user: AuthenticatedUser): Promise<ApiSuccessBody<{ updated: number }>> {
    return ok(await this.notifications.markAllRead(user.userId));
  }

  @Patch(":id/read")
  @ApiOperation({ summary: "Mark one of the caller's notifications as read" })
  async read(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseObjectIdPipe) id: string,
  ): Promise<ApiSuccessBody<NotificationView>> {
    return ok(await this.notifications.markRead(user.userId, id));
  }

  @Post("device-token")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: "Register (or refresh) this device's FCM token for the caller" })
  async registerDeviceToken(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RegisterDeviceTokenDto,
  ): Promise<ApiSuccessBody<DeviceTokenView>> {
    return ok(await this.deviceTokens.register(user.userId, dto));
  }

  @Post("device-token/deactivate")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Stop pushes to this device (sign out)" })
  async deactivateDeviceToken(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: DeactivateDeviceTokenDto,
  ): Promise<ApiSuccessBody<{ deactivated: boolean }>> {
    return ok({ deactivated: await this.deviceTokens.deactivate(user.userId, dto.token) });
  }
}
