import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { GOOGLE_TOKEN_URL, serviceAccountAssertion } from "./google-oauth";
import { PushGateway } from "./push.gateway";
import type { PushMessage, PushResult } from "./push.gateway";

interface FcmErrorBody {
  error?: {
    code?: number;
    status?: string;
    message?: string;
    details?: Array<{ "@type"?: string; errorCode?: string }>;
  };
}

/** FCM answers that mean "this token will never work again". */
const DEAD_TOKEN_CODES = new Set(["UNREGISTERED", "SENDER_ID_MISMATCH"]);

/**
 * Firebase Cloud Messaging HTTP v1 over Node's fetch — no firebase-admin
 * SDK. A service-account assertion is exchanged for an OAuth token (cached
 * until shortly before it expires); each device gets its own request, so
 * one dead token never fails the others. Every call has a hard timeout.
 */
@Injectable()
export class FcmHttpGateway extends PushGateway {
  private readonly logger = new Logger(FcmHttpGateway.name);
  private readonly projectId: string;
  private readonly clientEmail: string;
  private readonly privateKey: string;
  private readonly timeoutMs: number;
  private readonly channelId: string;
  private accessToken?: { value: string; expiresAt: number };
  private tokenRequest?: Promise<string>;

  constructor(config: ConfigService) {
    super();
    this.projectId = config.get<string>("firebaseProjectId") ?? "";
    this.clientEmail = config.get<string>("firebaseClientEmail") ?? "";
    this.privateKey = config.get<string>("firebasePrivateKey") ?? "";
    this.timeoutMs = config.getOrThrow<number>("fcmTimeoutMs");
    this.channelId = config.getOrThrow<string>("pushAndroidChannelId");
    if (!this.isConfigured)
      this.logger.warn("Firebase credentials are not set: push notifications are disabled (in-app only)");
  }

  get isConfigured(): boolean {
    return Boolean(this.projectId && this.clientEmail && this.privateKey);
  }

  async send(tokens: string[], message: PushMessage): Promise<PushResult[]> {
    if (!this.isConfigured)
      return tokens.map((token) => ({ token, delivered: false, tokenInvalid: false, error: "FCM not configured" }));
    return Promise.all(tokens.map((token) => this.sendOne(token, message)));
  }

  private async sendOne(token: string, message: PushMessage, retried = false): Promise<PushResult> {
    let response: Response;
    try {
      response = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(this.projectId)}/messages:send`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${await this.oauthToken()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ message: this.payload(token, message) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { token, delivered: false, tokenInvalid: false, error: `FCM unreachable: ${reason}` };
    }
    if (response.ok) return { token, delivered: true, tokenInvalid: false };

    const body = (await response.json().catch(() => ({}))) as FcmErrorBody;
    const code = body.error?.details?.find((detail) => detail.errorCode)?.errorCode ?? body.error?.status ?? "";
    // Our OAuth token was revoked or expired early: fetch a new one once.
    if (response.status === 401 && !retried) {
      this.accessToken = undefined;
      return this.sendOne(token, message, true);
    }
    // One quick retry for FCM-side trouble; the in-app record remains either way.
    if ((response.status === 429 || response.status >= 500) && !retried) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return this.sendOne(token, message, true);
    }
    const tokenInvalid =
      DEAD_TOKEN_CODES.has(code) ||
      response.status === 404 ||
      (response.status === 400 && /registration token/i.test(body.error?.message ?? ""));
    return {
      token,
      delivered: false,
      tokenInvalid,
      error: `FCM ${response.status} ${code}: ${body.error?.message ?? "request failed"}`.slice(0, 300),
    };
  }

  private payload(token: string, message: PushMessage): Record<string, unknown> {
    return {
      token,
      notification: { title: message.title, body: message.body },
      data: message.data,
      android: {
        priority: message.highPriority ? "HIGH" : "NORMAL",
        notification: {
          channel_id: this.channelId,
          sound: "default",
          ...(message.collapseKey ? { tag: message.collapseKey } : {}),
        },
      },
      apns: {
        headers: {
          "apns-priority": message.highPriority ? "10" : "5",
          ...(message.collapseKey ? { "apns-collapse-id": message.collapseKey.slice(0, 64) } : {}),
        },
        payload: { aps: { sound: "default" } },
      },
    };
  }

  private async oauthToken(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt > Date.now()) return this.accessToken.value;
    // Concurrent sends share one token request.
    this.tokenRequest ??= this.fetchOauthToken().finally(() => {
      this.tokenRequest = undefined;
    });
    return this.tokenRequest;
  }

  private async fetchOauthToken(): Promise<string> {
    const response = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: serviceAccountAssertion(this.clientEmail, this.privateKey),
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const body = (await response.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      error_description?: string;
    };
    if (!response.ok || !body.access_token) {
      this.logger.error(`Google OAuth token request failed: ${response.status} ${body.error_description ?? ""}`);
      throw new Error("Could not obtain an FCM access token");
    }
    // Refresh a minute early so a token never expires mid-send.
    this.accessToken = {
      value: body.access_token,
      expiresAt: Date.now() + Math.max(60, (body.expires_in ?? 3600) - 60) * 1000,
    };
    return body.access_token;
  }
}
