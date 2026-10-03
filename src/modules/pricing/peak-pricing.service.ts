import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectModel } from "@nestjs/mongoose";
import type { Model } from "mongoose";
import { Types } from "mongoose";
import { apiBadRequest, apiConflict, apiNotFound } from "../../common/exceptions/api.exception";
import type { CreatePeakSlotDto, UpdatePeakSlotDto } from "./dto/peak-slot.dto";
import {
  crossesMidnight,
  findConflict,
  formatTimeOfDay,
  minuteOfDay,
  parseTimeOfDay,
  resolvePeak,
  windowContains,
} from "./peak-pricing";
import type { PeakRule } from "./peak-pricing";
import { PeakPricingSlot } from "./schemas/peak-pricing-slot.schema";
import type { PeakPricingSlotDocument } from "./schemas/peak-pricing-slot.schema";

export interface PeakSlotView {
  id: string;
  name: string;
  startTime: string;
  endTime: string;
  crossesMidnight: boolean;
  hikePercent: number;
  appliesToAll: boolean;
  rideTypes: string[];
  isActive: boolean;
  /** In force right now (active and the clock is inside the window). */
  isLive: boolean;
  version: number;
  createdBy?: string;
  updatedBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Active rules are re-read at most this often by the pricing hot path (writes clear it at once). */
const RULES_CACHE_MS = 5_000;

const isDuplicateKey = (error: unknown): boolean => (error as { code?: number } | undefined)?.code === 11000;

/** The fields an edit can change, in the shape the audit log records. */
export type PeakSlotSnapshot = Pick<
  PeakSlotView,
  "name" | "startTime" | "endTime" | "hikePercent" | "appliesToAll" | "rideTypes" | "isActive"
>;

export const snapshotOf = (slot: PeakSlotSnapshot): PeakSlotSnapshot => ({
  name: slot.name,
  startTime: slot.startTime,
  endTime: slot.endTime,
  hikePercent: slot.hikePercent,
  appliesToAll: slot.appliesToAll,
  rideTypes: [...slot.rideTypes],
  isActive: slot.isActive,
});

/**
 * Peak-hour slots: admin CRUD with the business rules (no overlap for a ride
 * type, valid windows, unique names) and the resolver the pricing engine asks
 * "is a peak in force for this ride type right now?".
 */
@Injectable()
export class PeakPricingService {
  private readonly timeZone: string;
  private rulesCache?: { rules: Array<PeakRule>; expiresAt: number };
  /** Serialises writes so two admins cannot both pass the overlap check (per API node). */
  private writes: Promise<unknown> = Promise.resolve();

  constructor(
    @InjectModel(PeakPricingSlot.name) private readonly slots: Model<PeakPricingSlot>,
    config: ConfigService,
  ) {
    this.timeZone = config.getOrThrow<string>("appTimeZone");
  }

  get businessTimeZone(): string {
    return this.timeZone;
  }

  // ── Reading ───────────────────────────────────────────────────────────

  async list(): Promise<PeakPricingSlotDocument[]> {
    return this.slots.find().sort({ isActive: -1, startTime: 1, name: 1 }).exec();
  }

  async get(id: string): Promise<PeakPricingSlotDocument> {
    const slot = Types.ObjectId.isValid(id) ? await this.slots.findById(id).exec() : null;
    if (!slot) throw apiNotFound("Peak slot not found", "PEAK_SLOT_NOT_FOUND");
    return slot;
  }

  toView(slot: PeakPricingSlotDocument, at = new Date()): PeakSlotView {
    return {
      id: slot._id.toString(),
      name: slot.name,
      startTime: slot.startTime,
      endTime: slot.endTime,
      crossesMidnight: crossesMidnight(slot),
      hikePercent: slot.hikePercent,
      appliesToAll: slot.appliesToAll,
      rideTypes: [...slot.rideTypes],
      isActive: slot.isActive,
      isLive: slot.isActive && windowContains(slot, minuteOfDay(at, this.timeZone)),
      version: slot.version,
      createdBy: slot.createdBy?.toString(),
      updatedBy: slot.updatedBy?.toString(),
      createdAt: slot.createdAt,
      updatedAt: slot.updatedAt,
    };
  }

  // ── Resolver (pricing hot path) ───────────────────────────────────────

  /** The active peak for `rideType` at `at` (server clock unless given), if any. */
  async resolve(rideType: string, at: Date = new Date()): Promise<PeakRule | undefined> {
    return resolvePeak(await this.activeRules(), rideType, minuteOfDay(at, this.timeZone));
  }

  private async activeRules(): Promise<PeakRule[]> {
    if (this.rulesCache && this.rulesCache.expiresAt > Date.now()) return this.rulesCache.rules;
    const docs = await this.slots.find({ isActive: true }).lean().exec();
    const rules = docs.map(
      (doc): PeakRule => ({
        id: doc._id.toString(),
        name: doc.name,
        startTime: doc.startTime,
        endTime: doc.endTime,
        hikePercent: doc.hikePercent,
        appliesToAll: doc.appliesToAll,
        rideTypes: doc.rideTypes,
      }),
    );
    this.rulesCache = { rules, expiresAt: Date.now() + RULES_CACHE_MS };
    return rules;
  }

  // ── Writing ───────────────────────────────────────────────────────────

  create(dto: CreatePeakSlotDto, adminUserId: string): Promise<PeakPricingSlotDocument> {
    return this.serialised(async () => {
      const draft = this.normalise({
        name: dto.name,
        startTime: dto.startTime,
        endTime: dto.endTime,
        hikePercent: dto.hikePercent,
        appliesToAll: dto.appliesToAll ?? !dto.rideTypes?.length,
        rideTypes: dto.rideTypes ?? [],
        isActive: dto.isActive ?? true,
      });
      await this.assertNoConflict(draft);
      try {
        return await this.slots.create({
          ...draft,
          nameKey: draft.name.toLowerCase(),
          version: 1,
          createdBy: new Types.ObjectId(adminUserId),
          updatedBy: new Types.ObjectId(adminUserId),
        });
      } catch (error) {
        if (isDuplicateKey(error)) throw nameTaken(draft.name);
        throw error;
      } finally {
        this.rulesCache = undefined;
      }
    });
  }

  /** Returns the slot as it was and as it is now, for the audit trail. */
  update(
    id: string,
    dto: UpdatePeakSlotDto,
    adminUserId: string,
  ): Promise<{ before: PeakSlotSnapshot; slot: PeakPricingSlotDocument }> {
    return this.serialised(async () => {
      const current = await this.get(id);
      const before = snapshotOf(current);
      const rideTypes = dto.rideTypes ?? current.rideTypes;
      const draft = this.normalise({
        name: dto.name ?? current.name,
        startTime: dto.startTime ?? current.startTime,
        endTime: dto.endTime ?? current.endTime,
        hikePercent: dto.hikePercent ?? current.hikePercent,
        appliesToAll: dto.appliesToAll ?? (dto.rideTypes?.length ? false : current.appliesToAll),
        rideTypes,
        isActive: dto.isActive ?? current.isActive,
      });
      if (JSON.stringify(draft) === JSON.stringify(before))
        throw apiBadRequest("Nothing to change: the slot already has these values", "PEAK_SLOT_INVALID");
      await this.assertNoConflict(draft, id);
      return this.save(current, draft, adminUserId, before);
    });
  }

  setActive(
    id: string,
    isActive: boolean,
    adminUserId: string,
  ): Promise<{ before: PeakSlotSnapshot; slot: PeakPricingSlotDocument }> {
    return this.serialised(async () => {
      const current = await this.get(id);
      const before = snapshotOf(current);
      if (current.isActive === isActive) return { before, slot: current };
      const draft = { ...before, isActive };
      // Turning a slot back on must not collide with what was added meanwhile.
      await this.assertNoConflict(draft, id);
      return this.save(current, draft, adminUserId, before);
    });
  }

  /** Only a disabled slot can be deleted: switching it off first is the deliberate step. */
  remove(id: string): Promise<PeakSlotSnapshot> {
    return this.serialised(async () => {
      const current = await this.get(id);
      if (current.isActive)
        throw apiConflict("Disable the slot before deleting it", "PEAK_SLOT_STILL_ACTIVE");
      await current.deleteOne();
      this.rulesCache = undefined;
      return snapshotOf(current);
    });
  }

  // ── Rules ─────────────────────────────────────────────────────────────

  private normalise(input: PeakSlotSnapshot): PeakSlotSnapshot {
    const name = input.name.trim();
    if (parseTimeOfDay(input.startTime) === parseTimeOfDay(input.endTime))
      throw apiBadRequest(
        "Start and end time must differ. For a slot that crosses midnight, make the end earlier than the start (10:00 PM → 2:00 AM).",
        "PEAK_SLOT_INVALID",
      );
    const rideTypes = input.appliesToAll ? [] : [...new Set(input.rideTypes)];
    if (!input.appliesToAll && rideTypes.length === 0)
      throw apiBadRequest("Choose at least one ride type, or apply the slot to all ride types", "PEAK_SLOT_INVALID");
    return { ...input, name, rideTypes };
  }

  private async assertNoConflict(draft: PeakSlotSnapshot, ignoreId?: string): Promise<void> {
    const sameName = await this.slots
      .findOne({ nameKey: draft.name.toLowerCase(), ...(ignoreId ? { _id: { $ne: ignoreId } } : {}) })
      .select("_id")
      .lean()
      .exec();
    if (sameName) throw nameTaken(draft.name);
    if (!draft.isActive) return;

    const active = await this.slots.find({ isActive: true }).lean().exec();
    const others = active.map(
      (doc): PeakRule => ({
        id: doc._id.toString(),
        name: doc.name,
        startTime: doc.startTime,
        endTime: doc.endTime,
        hikePercent: doc.hikePercent,
        appliesToAll: doc.appliesToAll,
        rideTypes: doc.rideTypes,
      }),
    );
    const clash = findConflict({ id: ignoreId ?? "new", ...draft }, others);
    if (clash)
      throw apiConflict(
        `Overlaps "${clash.name}" (${formatTimeOfDay(clash.startTime)} – ${formatTimeOfDay(clash.endTime)}) for ${
          clash.appliesToAll || draft.appliesToAll ? "the same ride types" : "a shared ride type"
        }. Change the times or the ride types, or disable the other slot first.`,
        "PEAK_SLOT_OVERLAP",
      );
  }

  /** Optimistic-concurrency write: loses (409) if another admin edited the slot meanwhile. */
  private async save(
    current: PeakPricingSlotDocument,
    draft: PeakSlotSnapshot,
    adminUserId: string,
    before: PeakSlotSnapshot,
  ): Promise<{ before: PeakSlotSnapshot; slot: PeakPricingSlotDocument }> {
    try {
      const slot = await this.slots
        .findOneAndUpdate(
          { _id: current._id, version: current.version },
          {
            $set: { ...draft, nameKey: draft.name.toLowerCase(), updatedBy: new Types.ObjectId(adminUserId) },
            $inc: { version: 1 },
          },
          { returnDocument: "after", runValidators: true },
        )
        .exec();
      if (!slot) throw apiConflict("Someone else changed this slot. Reload and try again.", "PEAK_SLOT_CHANGED");
      return { before, slot };
    } catch (error) {
      if (isDuplicateKey(error)) throw nameTaken(draft.name);
      throw error;
    } finally {
      this.rulesCache = undefined;
    }
  }

  private serialised<T>(task: () => Promise<T>): Promise<T> {
    const run = this.writes.then(task, task);
    this.writes = run.catch(() => undefined);
    return run;
  }
}

function nameTaken(name: string) {
  return apiConflict(`A peak slot named "${name}" already exists`, "PEAK_SLOT_NAME_TAKEN");
}
