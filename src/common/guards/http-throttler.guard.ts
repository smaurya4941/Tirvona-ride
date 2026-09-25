import { Injectable } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";

/**
 * The app-wide HTTP rate limit. Socket messages are rate-limited per
 * connection inside the realtime layer instead — ThrottlerGuard reads
 * Express request/response objects that a WebSocket context does not have.
 */
@Injectable()
export class HttpThrottlerGuard extends ThrottlerGuard {
  override async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== "http") return true;
    return super.canActivate(context);
  }
}
