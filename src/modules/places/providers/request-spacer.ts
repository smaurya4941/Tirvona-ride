import { GeocodingProviderError } from "./geocoding.provider";

/**
 * Spaces calls to one upstream at least `minIntervalMs` apart across the
 * whole process (public geocoders ask for a per-application rate). A caller
 * that would wait longer than `maxWaitMs` is refused with a retryable error
 * instead, so a burst of riders never queues for seconds — PlacesService (or
 * a fallback provider) then answers from elsewhere.
 */
export class RequestSpacer {
  private nextSlotAt = 0;

  constructor(
    private readonly upstream: string,
    private readonly minIntervalMs: number,
    private readonly maxWaitMs: number,
  ) {}

  async acquire(): Promise<void> {
    if (this.minIntervalMs <= 0) return;
    const now = Date.now();
    const slot = Math.max(now, this.nextSlotAt);
    const wait = slot - now;
    if (wait > this.maxWaitMs) throw new GeocodingProviderError(`${this.upstream} request budget exhausted`, true);
    this.nextSlotAt = slot + this.minIntervalMs;
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  }
}
