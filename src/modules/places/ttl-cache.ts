interface Entry<V> {
  value: V;
  expiresAt: number;
}

/**
 * Bounded in-memory LRU cache with per-entry expiry, plus request
 * coalescing: concurrent `getOrLoad` calls for one key share a single
 * loader call. Failed loads are never cached.
 *
 * Per-process by design — geocoding answers are public, cheap to recompute
 * and fine to differ briefly between nodes.
 */
export class TtlCache<V> {
  private readonly entries = new Map<string, Entry<V>>();
  private readonly inFlight = new Map<string, Promise<V>>();

  constructor(
    private readonly maxEntries: number,
    private readonly now: () => number = Date.now,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    // Re-insert: Map iteration order is the LRU order.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V, ttlMs: number): void {
    if (ttlMs <= 0 || this.maxEntries <= 0) return;
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  async getOrLoad(key: string, ttlMs: number, loader: () => Promise<V>): Promise<V> {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const load = loader()
      .then((value) => {
        this.set(key, value, ttlMs);
        return value;
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, load);
    return load;
  }

  clear(): void {
    this.entries.clear();
  }
}
