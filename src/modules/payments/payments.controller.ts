import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, Post, Query, Req } from "@nestjs/common";
import type { RawBodyRequest } from "@nestjs/common";
import { ApiBearerAuth, ApiExcludeEndpoint, ApiOperation, ApiTags } from "@nestjs/swagger";
import { SkipThrottle } from "@nestjs/throttler";
import type { Request } from "express";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Public } from "../../common/decorators/public.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { ok } from "../../common/http/api-response";
import type { ApiSuccessBody } from "../../common/http/api-response";
import { ParseObjectIdPipe } from "../../common/pipes/parse-object-id.pipe";
import type { AuthenticatedUser } from "../../common/types/jwt-payload";
import { UserRole } from "../../common/types/user-role.enum";
import { CreatePaymentDto, PaymentFailureDto, PaymentHistoryQueryDto, VerifyPaymentDto } from "./dto/payment.dto";
import type { CheckoutView, PaymentHistoryItem, PaymentReceiptView, PaymentView } from "./interfaces/payment-views";
import { PaymentWebhookService } from "./payment-webhook.service";
import type { WebhookResult } from "./payment-webhook.service";
import { PaymentsService } from "./payments.service";

// Static segments (create, cash, verify, webhook, history) are declared before
// `:id` so Express never treats them as payment ids.
@ApiTags("Payments")
@Controller({ path: "payments", version: "1" })
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly webhooks: PaymentWebhookService,
  ) {}

  @Post("create")
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @Roles(UserRole.CUSTOMER)
  @ApiOperation({ summary: "Open (or re-open) payment for a completed ride; returns the Razorpay checkout" })
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreatePaymentDto,
  ): Promise<ApiSuccessBody<CheckoutView>> {
    return ok(await this.payments.create(user.userId, dto.rideId));
  }

  @Post("cash")
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @Roles(UserRole.CUSTOMER)
  @ApiOperation({
    summary: "Pay the driver in cash: marks the completed ride paid (method CASH) for its final fare",
    description:
      "Same checks as /payments/create. 409 PAYMENT_ALREADY_COMPLETED when paid, " +
      "409 PAYMENT_IN_PROGRESS while an online payment is still being confirmed.",
  })
  async payCash(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreatePaymentDto,
  ): Promise<ApiSuccessBody<PaymentView>> {
    return ok(await this.payments.payCash(user.userId, dto.rideId));
  }

  @Post("verify")
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @Roles(UserRole.CUSTOMER)
  @ApiOperation({ summary: "Verify a Razorpay checkout result server-side (signature + gateway + amount)" })
  async verify(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: VerifyPaymentDto,
  ): Promise<ApiSuccessBody<PaymentView>> {
    return ok(await this.payments.verify(user.userId, dto));
  }

  /** Razorpay → Tirvona. Authenticated by the HMAC signature, not a JWT. */
  @Post("webhook")
  @Public()
  @SkipThrottle()
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint()
  async webhook(
    @Req() request: RawBodyRequest<Request>,
    @Headers("x-razorpay-signature") signature?: string,
    @Headers("x-razorpay-event-id") eventId?: string,
  ): Promise<ApiSuccessBody<WebhookResult>> {
    return ok(await this.webhooks.handle(request.rawBody, signature, eventId));
  }

  @Get("history")
  @ApiBearerAuth()
  @Roles(UserRole.CUSTOMER)
  @ApiOperation({ summary: "The customer's payments, newest first" })
  async history(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: PaymentHistoryQueryDto,
  ): Promise<ApiSuccessBody<{ items: PaymentHistoryItem[]; page: number; limit: number; total: number; hasMore: boolean }>> {
    return ok(await this.payments.history(user.userId, query));
  }

  @Get(":id")
  @ApiBearerAuth()
  @Roles(UserRole.CUSTOMER)
  @ApiOperation({ summary: "Payment detail and in-app receipt" })
  async receipt(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseObjectIdPipe) id: string,
  ): Promise<ApiSuccessBody<PaymentReceiptView>> {
    return ok(await this.payments.receipt(user.userId, id));
  }

  @Post(":id/failure")
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @Roles(UserRole.CUSTOMER)
  @ApiOperation({ summary: "Report a failed/dismissed checkout so the app can offer a retry (advisory)" })
  async failure(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseObjectIdPipe) id: string,
    @Body() dto: PaymentFailureDto,
  ): Promise<ApiSuccessBody<PaymentView>> {
    return ok(await this.payments.reportFailure(user.userId, id, dto));
  }
}
