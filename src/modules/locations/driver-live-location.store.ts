import { Injectable } from "@nestjs/common";
import type { GeoCoordinates } from "./geo";

export interface LiveLocation extends GeoCoordinates {
  heading?: number;
  speed?: number;
  accuracy?: number;
  /** Device time of the fix (clamped so it is never in the future). */
  recordedAt: Date;
  /** Server time the fix arrived. */
  receivedAt: Date;
}

interface DriverEntry {
  location?: LiveLocation;
  lastAcceptedAt?: number;
  lastCheckpointAt?: number;
}

/**
 * Process-local, high-frequency driver state: the latest fix of every driver
 * and the per-driver throttling clocks. Nothing here is a source of record —
 * MongoDB keeps the (throttled) last known position for matching and
 * recovery, so losing this map on restart only costs a few seconds of
 * freshness.
 *
 * This is the class Redis replaces when the API runs on several nodes: the
 * same four operations map onto a hash per driver with a TTL.
 */
@Injectable()
export class DriverLiveLocationStore {
  /** Entries idle for longer than this are evicted on the next sweep. */
  private static readonly IDLE_TTL_MS = 30 * 60_000;
  private readonly entries = new Map<string, DriverEntry>();
  private lastEvictionAt = Date.now();

  latest(driverId: string, maxAgeMs?: number): LiveLocation | undefined {
    const location = this.entries.get(driverId)?.location;
    if (!location) return undefined;
    if (maxAgeMs !== undefined && Date.now() - location.receivedAt.getTime() > maxAgeMs) return undefined;
    return location;
  }

  /**
   * Token-bucket of one: true (and the clock advances) when at least
   * `minIntervalMs` passed since the last accepted fix of this driver.
   */
  tryAccept(driverId: string, minIntervalMs: number, now = Date.now()): boolean {
    const entry = this.entry(driverId);
    if (entry.lastAcceptedAt !== undefined && now - entry.lastAcceptedAt < minIntervalMs) return false;
    entry.lastAcceptedAt = now;
    return true;
  }

  save(driverId: string, location: LiveLocation): void {
    this.entry(driverId).location = location;
    this.evictIdle();
  }

  /** True (and the clock advances) when a trail checkpoint is due. */
  checkpointDue(driverId: string, intervalMs: number, now = Date.now()): boolean {
    const entry = this.entry(driverId);
    if (entry.lastCheckpointAt !== undefined && now - entry.lastCheckpointAt < intervalMs) return false;
    entry.lastCheckpointAt = now;
    return true;
  }

  /** Called when a ride ends so the next ride's trail starts immediately. */
  resetCheckpointClock(driverId: string): void {
    const entry = this.entries.get(driverId);
    if (entry) entry.lastCheckpointAt = undefined;
  }

  forget(driverId: string): void {
    this.entries.delete(driverId);
  }

  private entry(driverId: string): DriverEntry {
    let entry = this.entries.get(driverId);
    if (!entry) {
      entry = {};
      this.entries.set(driverId, entry);
    }
    return entry;
  }

  private evictIdle(now = Date.now()): void {
    if (now - this.lastEvictionAt < 60_000) return;
    this.lastEvictionAt = now;
    for (const [driverId, entry] of this.entries) {
      const lastActivity = Math.max(entry.lastAcceptedAt ?? 0, entry.location?.receivedAt.getTime() ?? 0);
      if (now - lastActivity > DriverLiveLocationStore.IDLE_TTL_MS) this.entries.delete(driverId);
    }
  }
}
