import { randomUUID } from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { WhatsAppDeliveryError, WhatsAppGateway } from "./whatsapp.gateway";
import type { AuthenticationCodeMessage, SosAlertMessage, WhatsAppSendResult } from "./whatsapp.gateway";

/**
 * Development stand-in for Meta: prints the code to the server log so the
 * signup flow can be exercised without a WhatsApp Business account.
 * Environment validation refuses WHATSAPP_PROVIDER=log in production; the
 * constructor refuses it again as a second line of defence.
 */
@Injectable()
export class LogWhatsAppGateway extends WhatsAppGateway {
  readonly provider = "log";
  private readonly logger = new Logger(LogWhatsAppGateway.name);
  private readonly production: boolean;

  constructor(config: ConfigService) {
    super();
    this.production = config.get<string>("nodeEnv") === "production";
    if (!this.production)
      this.logger.warn("WhatsApp is not configured: signup codes are printed to this log (development only)");
  }

  async sendAuthenticationCode(message: AuthenticationCodeMessage): Promise<WhatsAppSendResult> {
    if (this.production)
      throw new WhatsAppDeliveryError("MISCONFIGURED", "The log WhatsApp gateway is disabled in production");
    // Plain ASCII: the Windows console garbles arrows.
    this.logger.log(`[DEV OTP] >>> ${message.code} <<< for ${message.to} (WhatsApp not configured)`);
    return { messageId: `log-${randomUUID()}` };
  }

  async sendSosAlert(message: SosAlertMessage): Promise<WhatsAppSendResult> {
    if (this.production)
      throw new WhatsAppDeliveryError("MISCONFIGURED", "The log WhatsApp gateway is disabled in production");
    this.logger.log(
      `[DEV SOS ${message.kind}] ${message.reference} for ${message.to}: ${message.personName} at ` +
        `${message.location.latitude},${message.location.longitude}, track ${message.trackingUrl}`,
    );
    return { messageId: `log-${randomUUID()}` };
  }
}
