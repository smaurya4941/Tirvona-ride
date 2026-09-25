export interface PushMessage {
  title: string;
  body: string;
  /** String-only map delivered to the app (routing: type, rideId, …). */
  data: Record<string, string>;
  highPriority: boolean;
  /** Same tag = replaces the previous notification in the Android tray. */
  collapseKey?: string;
}

export interface PushResult {
  token: string;
  delivered: boolean;
  /** The token is dead (app uninstalled, token rotated): stop using it. */
  tokenInvalid: boolean;
  error?: string;
}

/**
 * The only door to the push provider. NotificationsService depends on this
 * abstraction; production binds the FCM HTTP v1 implementation, the e2e
 * suite an in-memory fake.
 */
export abstract class PushGateway {
  abstract readonly isConfigured: boolean;

  /** One result per token, in the same order. Never throws. */
  abstract send(tokens: string[], message: PushMessage): Promise<PushResult[]>;
}
