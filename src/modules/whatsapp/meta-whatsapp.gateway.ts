import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { maskPhone, toWhatsAppRecipient } from "../../common/phone/phone-number";
import { WhatsAppDeliveryError, WhatsAppGateway } from "./whatsapp.gateway";
import type { AuthenticationCodeMessage, WhatsAppFailureReason, WhatsAppSendResult } from "./whatsapp.gateway";

interface MetaErrorBody {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    error_data?: { details?: string };
    fbtrace_id?: string;
  };
}

interface MetaSendBody {
  messages?: Array<{ id?: string; message_status?: string }>;
}

/**
 * Meta error codes that tell us something actionable. Everything else is
 * classified by HTTP status. Reference: WhatsApp Cloud API error codes.
 */
const RECIPIENT_CODES = new Set([
  131026, // Message undeliverable (not on WhatsApp, old app, blocked business)
  131030, // Recipient not in the allowed list (test phone numbers)
]);
const RATE_LIMIT_CODES = new Set([
  4, // Application request limit
  80007, // WABA rate limit
  130429, // Cloud API throughput
  131048, // Spam rate limit
  131056, // Business/recipient pair rate limit
]);
const CONFIGURATION_CODES = new Set([
  0, // AuthException
  3, // Capability / permission
  10, // Permission denied
  100, // Invalid parameter (phone number id, payload)
  190, // Access token expired / invalid
  200, // Permission error
  131008, // Required parameter missing
  131009, // Parameter value invalid
  131031, // Account locked
  131045, // Incorrect certificate (unregistered sender)
  132000, // Template parameter count mismatch
  132001, // Template does not exist in this language
  132005, // Template hydrated text too long
  132007, // Template format character policy violated
  132012, // Template parameter format mismatch
  132015, // Template paused
  132016, // Template disabled
  133010, // Phone number not registered
]);

/**
 * WhatsApp Cloud API (graph.facebook.com) over Node's fetch — no SDK.
 * Sends the approved AUTHENTICATION template carrying the signup code.
 * The access token lives only here (backend environment) and is never
 * logged; neither is the code.
 *
 * One quick retry for transport failures and 5xx answers: a duplicate of
 * the same code is harmless, a lost code costs the user a resend.
 */
@Injectable()
export class MetaWhatsAppGateway extends WhatsAppGateway {
  readonly provider = "meta";
  private readonly logger = new Logger(MetaWhatsAppGateway.name);
  private readonly endpoint: string;
  private readonly accessToken: string;
  private readonly templateName: string;
  private readonly templateLanguage: string;
  private readonly codeButton: boolean;
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    super();
    const baseUrl = config.getOrThrow<string>("whatsappApiBaseUrl");
    const version = config.getOrThrow<string>("whatsappApiVersion");
    const phoneNumberId = config.getOrThrow<string>("whatsappPhoneNumberId");
    this.endpoint = `${baseUrl}/${version}/${encodeURIComponent(phoneNumberId)}/messages`;
    this.accessToken = config.getOrThrow<string>("whatsappAccessToken");
    this.templateName = config.getOrThrow<string>("whatsappOtpTemplateName");
    this.templateLanguage = config.getOrThrow<string>("whatsappOtpTemplateLanguage");
    this.codeButton = config.get<boolean>("whatsappOtpTemplateCodeButton") ?? true;
    this.timeoutMs = config.getOrThrow<number>("whatsappTimeoutMs");
  }

  async sendAuthenticationCode(message: AuthenticationCodeMessage): Promise<WhatsAppSendResult> {
    const body = JSON.stringify(this.templatePayload(message));
    const recipient = maskPhone(message.to);
    let lastError: WhatsAppDeliveryError | undefined;

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      let response: Response;
      try {
        response = await fetch(this.endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
            "Content-Type": "application/json",
          },
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        const reason = error instanceof Error ? error.name : "unknown";
        this.logger.warn(`WhatsApp API unreachable (attempt ${attempt}) for ${recipient}: ${reason}`);
        lastError = new WhatsAppDeliveryError("UNAVAILABLE", `WhatsApp API unreachable: ${reason}`);
        continue;
      }

      if (response.ok) {
        const parsed = (await response.json().catch(() => ({}))) as MetaSendBody;
        const messageId = parsed.messages?.[0]?.id ?? "";
        this.logger.log(`WhatsApp OTP accepted for ${recipient} (${messageId || "no message id"})`);
        return { messageId };
      }

      const failure = (await response.json().catch(() => ({}))) as MetaErrorBody;
      const reason = this.classify(response.status, failure);
      const error = failure.error ?? {};
      // Operator-facing detail only: code, subcode and trace id — never the
      // token, the code or the full number.
      const detail =
        `HTTP ${response.status} code=${error.code ?? "?"} subcode=${error.error_subcode ?? "-"} ` +
        `trace=${error.fbtrace_id ?? "-"}: ${(error.error_data?.details ?? error.message ?? "request failed").slice(0, 200)}`;
      const log = reason === "MISCONFIGURED" ? this.logger.error.bind(this.logger) : this.logger.warn.bind(this.logger);
      log(`WhatsApp OTP rejected for ${recipient} [${reason}] ${detail}`);
      lastError = new WhatsAppDeliveryError(reason, `WhatsApp API rejected the message: ${reason}`);
      if (reason !== "UNAVAILABLE") break;
    }

    throw lastError ?? new WhatsAppDeliveryError("UNAVAILABLE", "WhatsApp API request failed");
  }

  private templatePayload(message: AuthenticationCodeMessage): Record<string, unknown> {
    const components: Array<Record<string, unknown>> = [
      { type: "body", parameters: [{ type: "text", text: message.code }] },
    ];
    // Copy-code and one-tap authentication buttons are URL buttons whose
    // parameter is the code itself.
    if (this.codeButton)
      components.push({
        type: "button",
        sub_type: "url",
        index: "0",
        parameters: [{ type: "text", text: message.code }],
      });
    return {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: toWhatsAppRecipient(message.to),
      type: "template",
      template: {
        name: this.templateName,
        language: { code: this.templateLanguage },
        components,
      },
    };
  }

  private classify(status: number, body: MetaErrorBody): WhatsAppFailureReason {
    const code = body.error?.code;
    if (code !== undefined) {
      if (RECIPIENT_CODES.has(code)) return "RECIPIENT_UNAVAILABLE";
      if (RATE_LIMIT_CODES.has(code)) return "RATE_LIMITED";
      if (CONFIGURATION_CODES.has(code)) return "MISCONFIGURED";
    }
    if (status === 429) return "RATE_LIMITED";
    if (status === 401 || status === 403) return "MISCONFIGURED";
    if (status >= 500) return "UNAVAILABLE";
    return "MISCONFIGURED";
  }
}
