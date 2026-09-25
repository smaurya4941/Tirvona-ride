import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { DriversModule } from "../drivers/drivers.module";
import { EarningsModule } from "../earnings/earnings.module";
import { RidesModule } from "../rides/rides.module";
import { UsersModule } from "../users/users.module";
import { PaymentWebhookService } from "./payment-webhook.service";
import { PaymentsAdminService } from "./payments-admin.service";
import { PaymentsController } from "./payments.controller";
import { PaymentsReconciler } from "./payments.reconciler";
import { PaymentsService } from "./payments.service";
import { RazorpayHttpGateway } from "./razorpay/razorpay-http.gateway";
import { RazorpayGateway } from "./razorpay/razorpay.gateway";
import { Payment, PaymentSchema } from "./schemas/payment.schema";
import { PaymentWebhookEvent, PaymentWebhookEventSchema } from "./schemas/payment-webhook-event.schema";

// Payments → Rides (ride payment state), Earnings (ledger), Users/Drivers (names).
// Nothing depends on Payments except Admin.
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Payment.name, schema: PaymentSchema },
      { name: PaymentWebhookEvent.name, schema: PaymentWebhookEventSchema },
    ]),
    UsersModule,
    DriversModule,
    RidesModule,
    EarningsModule,
  ],
  controllers: [PaymentsController],
  providers: [
    { provide: RazorpayGateway, useClass: RazorpayHttpGateway },
    PaymentsService,
    PaymentWebhookService,
    PaymentsReconciler,
    PaymentsAdminService,
  ],
  exports: [PaymentsService, PaymentsAdminService, PaymentsReconciler],
})
export class PaymentsModule {}
