import { plainToInstance } from "class-transformer";
import type { ClassConstructor } from "class-transformer";
import { IsMongoId, validate } from "class-validator";
import { RealtimeErrorCode } from "./realtime.constants";
import type { Ack } from "./realtime.types";

export class RideRoomDto {
  @IsMongoId()
  rideId!: string;
}

export type Validated<T> = { ok: true; value: T } | { ok: false; ack: Ack };

export const failure = (code: string, message: string, details?: unknown): Ack => ({
  ok: false,
  code,
  message,
  ...(details === undefined ? {} : { details }),
});

/**
 * The HTTP ValidationPipe's rules (transform + whitelist + reject unknown
 * fields) applied to a socket message, answering with a failed ack instead
 * of throwing into Nest's WS exception handler.
 */
export async function validatePayload<T extends object>(
  type: ClassConstructor<T>,
  body: unknown,
): Promise<Validated<T>> {
  if (body === null || typeof body !== "object" || Array.isArray(body))
    return { ok: false, ack: failure(RealtimeErrorCode.VALIDATION_FAILED, "Payload must be an object") };
  const value = plainToInstance(type, body);
  const errors = await validate(value, { whitelist: true, forbidNonWhitelisted: true });
  if (errors.length === 0) return { ok: true, value };
  return {
    ok: false,
    ack: failure(
      RealtimeErrorCode.VALIDATION_FAILED,
      "Invalid payload",
      errors.flatMap((error) => Object.values(error.constraints ?? {})),
    ),
  };
}

/** Fixed-window counter per key (socket id) for cheap per-connection limits. */
export class WindowRateLimiter {
  private readonly windows = new Map<string, { startedAt: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  allow(key: string, now = Date.now()): boolean {
    const window = this.windows.get(key);
    if (!window || now - window.startedAt >= this.windowMs) {
      this.windows.set(key, { startedAt: now, count: 1 });
      return true;
    }
    window.count += 1;
    return window.count <= this.limit;
  }

  forget(key: string): void {
    this.windows.delete(key);
  }
}
