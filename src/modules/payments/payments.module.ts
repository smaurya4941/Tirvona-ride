import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { DriversModule } from "../drivers/drivers.module";
import { EarningsModule } from "../earnings/earnings.module";
import { RidesModule } from "../rides/rides.module";
import { UsersModule } from "../users/users.module";
import { PaymentReconciliationService } from "./payment-reconciliation.service";
import { PaymentWebhookService } from "./payment-webhook.service";
import { PaymentsAdminService } from "./payments-admin.service";
import { PaymentsController } from "./payments.controller";
import { PaymentsReconciler } from "./payments.reconciler";
import { PaymentsService } from "./payments.service";
import { RazorpayHttpGateway } from "./razorpay/razorpay-http.gateway";
import { RazorpayGateway } from "./razorpay/razorpay.gateway";
import { RefundsService } from "./refunds.service";
import { Payment, PaymentSchema } from "./schemas/payment.schema";
import { PaymentReconciliationRun, PaymentReconciliationRunSchema } from "./schemas/payment-reconciliation-run.schema";
import { PaymentRefund, PaymentRefundSchema } from "./schemas/payment-refund.schema";
import { PaymentWebhookEvent, PaymentWebhookEventSchema } from "./schemas/payment-webhook-event.schema";

// Payments → Rides (ride payment state), Earnings (ledger + clawbacks),
// Users/Drivers (names). Nothing depends on Payments except Admin.
// Inside: PaymentsService (orders, verify, capture) → RefundsService
// (refunds, totals, clawbacks) ← webhook / reconciler / reconciliation runs.
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Payment.name, schema: PaymentSchema },
      { name: PaymentWebhookEvent.name, schema: PaymentWebhookEventSchema },
      { name: PaymentRefund.name, schema: PaymentRefundSchema },
      { name: PaymentReconciliationRun.name, schema: PaymentReconciliationRunSchema },
    ]),
    UsersModule,
    DriversModule,
    RidesModule,
    EarningsModule,
  ],
  controllers: [PaymentsController],
  providers: [
    { provide: RazorpayGateway, useClass: RazorpayHttpGateway },
    RefundsService,
    PaymentsService,
    PaymentWebhookService,
    PaymentReconciliationService,
    PaymentsReconciler,
    PaymentsAdminService,
  ],
  exports: [PaymentsService, PaymentsAdminService, PaymentsReconciler, RefundsService, PaymentReconciliationService],
})
export class PaymentsModule {}
