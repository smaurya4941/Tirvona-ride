import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { LogWhatsAppGateway } from "./log-whatsapp.gateway";
import { MetaWhatsAppGateway } from "./meta-whatsapp.gateway";
import { WhatsAppGateway } from "./whatsapp.gateway";

/**
 * WhatsApp delivery (Meta Cloud API). Only the signup OTP uses it today —
 * ride PINs stay inside the app. WHATSAPP_PROVIDER picks the binding.
 */
@Module({
  providers: [
    {
      provide: WhatsAppGateway,
      inject: [ConfigService],
      useFactory: (config: ConfigService): WhatsAppGateway =>
        config.get<string>("whatsappProvider") === "meta"
          ? new MetaWhatsAppGateway(config)
          : new LogWhatsAppGateway(config),
    },
  ],
  exports: [WhatsAppGateway],
})
export class WhatsAppModule {}
