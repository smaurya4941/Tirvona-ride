import { createHash } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectModel } from "@nestjs/mongoose";
import type { Model, QueryFilter } from "mongoose";
import { Types } from "mongoose";
import { apiBadRequest, apiConflict, apiNotFound } from "../../common/exceptions/api.exception";
import { probeImage } from "../branding/image-probe";
import { LocationsService } from "../locations/locations.service";
import { joinLegs } from "../locations/polyline";
import { AuditLogService } from "../audit/audit-log.service";
import { PlacesService } from "../places/places.service";
import { POPULAR_IMAGE_RULE, imageProblem } from "../places/popular-places.service";
import { RideTypesService } from "../ride-types/ride-types.service";
import { checkAvailability, distanceWarning, effectiveCapacity, publishProblems } from "./circuit-package.rules";
import type { AvailabilityRule, PublishProblem } from "./circuit-package.rules";
import { PACKAGE_STATUS_TRANSITIONS, CircuitPackageStatus } from "./circuit-package.types";
import type {
  CircuitStopInputDto,
  CreateCircuitPackageDto,
  ListCircuitPackagesQueryDto,
  RoutePreviewDto,
  UpdateCircuitPackageDto,
} from "./dto/circuit-package.dto";
import { CircuitPackage, CircuitPackageCounter } from "./schemas/circuit-package.schema";
import type { CircuitPackageDocument } from "./schemas/circuit-package.schema";

export const CIRCUIT_COVER_RULE = POPULAR_IMAGE_RULE;

export interface CircuitStopView {
  order: number;
  placeId: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
}

export interface CircuitPricingView {
  basePrice: number;
  includedDistanceKm: number;
  includedDurationHours: number;
  includedDistanceMeters: number;
  includedDurationSeconds: number;
  extraDistanceRatePerKm: number;
  extraDurationRatePerHour: number;
}

export interface CircuitAvailabilityView {
  days: number[];
  opensAt: string;
  closesAt: string;
  validFrom?: string;
  validUntil?: string;
}

export interface CircuitPackageAdminView {
  id: string;
  code: string;
  name: string;
  description: string;
  city: string;
  status: CircuitPackageStatus;
  stops: CircuitStopView[];
  pricing?: CircuitPricingView;
  rideTypes: string[];
  maxPassengers: number;
  availability: CircuitAvailabilityView;
  cancellationPolicy?: string;
  referenceOrigin?: { label: string; latitude: number; longitude: number };
  coverPath: string | null;
  revision: number;
  hasBookings: boolean;
  /** What stops this package from being published; empty = ready. */
  publishProblems: PublishProblem[];
  publishedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface CircuitVehicleOption {
  rideType: string;
  displayName: string;
  icon: string;
  seatCapacity: number;
  /** The most passengers this vehicle may carry on this circuit. */
  maxPassengers: number;
}

export interface CircuitPackageCustomerView {
  id: string;
  code: string;
  name: string;
  description: string;
  city: string;
  stops: CircuitStopView[];
  pricing: CircuitPricingView;
  vehicles: CircuitVehicleOption[];
  maxPassengers: number;
  availability: CircuitAvailabilityView;
  /** Whether a booking started now is inside the package's season, weekday and hours. */
  availableNow: boolean;
  unavailableReason?: string;
  cancellationPolicy?: string;
  coverPath: string | null;
}

export interface RoutePreviewView {
  legs: Array<{
    from: string;
    to: string;
    distanceMeters: number;
    durationSeconds: number;
    provider: string;
  }>;
  /** Stop 1 → … → last stop. */
  stopsDistanceMeters: number;
  stopsDurationSeconds: number;
  /** Reference origin → stop 1, when one is configured. */
  originLeg?: { distanceMeters: number; durationSeconds: number; provider: string };
  polyline?: string;
  warnings: string[];
}

export interface CoverFile {
  data: Buffer;
  contentType: string;
  version: string;
}

type StopSnapshot = { order: number; placeId: string; name: string; address: string; latitude: number; longitude: number };

const isDuplicateKey = (error: unknown): boolean => (error as { code?: number } | undefined)?.code === 11000;
const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const round1 = (value: number): number => Math.round(value * 10) / 10;

const stopView = (stop: StopSnapshot): CircuitStopView => ({
  order: stop.order,
  placeId: stop.placeId,
  name: stop.name,
  address: stop.address,
  latitude: stop.latitude,
  longitude: stop.longitude,
});

const coverPath = (pkg: CircuitPackageDocument): string | null =>
  pkg.cover ? `/circuit-packages/${pkg._id.toString()}/cover?v=${pkg.cover.version}` : null;

function pricingView(pricing: NonNullable<CircuitPackage["pricing"]>): CircuitPricingView {
  return {
    basePrice: pricing.basePrice,
    includedDistanceKm: round1(pricing.includedDistanceMeters / 1000),
    includedDurationHours: Math.round((pricing.includedDurationSeconds / 3600) * 100) / 100,
    includedDistanceMeters: pricing.includedDistanceMeters,
    includedDurationSeconds: pricing.includedDurationSeconds,
    extraDistanceRatePerKm: pricing.extraDistanceRatePerKm,
    extraDurationRatePerHour: pricing.extraDurationRatePerHour,
  };
}

const availabilityView = (pkg: CircuitPackage): CircuitAvailabilityView => ({
  days: [...pkg.availability.days].sort((a, b) => a - b),
  opensAt: pkg.availability.opensAt,
  closesAt: pkg.availability.closesAt,
  validFrom: pkg.availability.validFrom ?? undefined,
  validUntil: pkg.availability.validUntil ?? undefined,
});

/**
 * Circuit packages: what Admin configures and customers browse. Owns package
 * CRUD, stop resolution against the Places provider, publishing rules, the
 * route preview and the audit trail. A package is never a ride: bookings copy
 * what they need (see CircuitRidesService), so nothing here can change a
 * circuit that was already booked.
 */
@Injectable()
export class CircuitPackagesService {
  private readonly timeZone: string;

  constructor(
    @InjectModel(CircuitPackage.name) private readonly packages: Model<CircuitPackage>,
    @InjectModel(CircuitPackageCounter.name) private readonly counters: Model<CircuitPackageCounter>,
    private readonly places: PlacesService,
    private readonly rideTypes: RideTypesService,
    private readonly locations: LocationsService,
    private readonly audit: AuditLogService,
    config: ConfigService,
  ) {
    this.timeZone = config.getOrThrow<string>("appTimeZone");
  }

  // ── Admin ─────────────────────────────────────────────────────────────

  async list(query: ListCircuitPackagesQueryDto): Promise<CircuitPackageAdminView[]> {
    const filter: QueryFilter<CircuitPackage> = {};
    if (query.status) filter.status = query.status;
    if (query.city) filter.city = { $regex: `^${escapeRegex(query.city)}$`, $options: "i" };
    if (query.q) {
      const pattern = { $regex: escapeRegex(query.q), $options: "i" };
      filter.$or = [{ name: pattern }, { code: pattern }];
    }
    const [rows, rideTypes] = await Promise.all([
      this.packages.find(filter).select("-cover.data").sort({ updatedAt: -1, _id: -1 }).exec(),
      this.rideTypeIndex(),
    ]);
    return rows.map((row) => this.toAdminView(row, rideTypes));
  }

  async getAdmin(id: string): Promise<CircuitPackageAdminView> {
    return this.toAdminView(await this.requirePackage(id), await this.rideTypeIndex());
  }

  async create(dto: CreateCircuitPackageDto, adminId: string): Promise<CircuitPackageAdminView> {
    const stops = dto.stops ? await this.resolveStops(dto.stops) : [];
    const rideTypes = dto.rideTypes ? await this.assertRideTypes(dto.rideTypes) : [];
    const created = await this.packages.create({
      code: await this.nextCode(),
      name: dto.name,
      description: dto.description ?? "",
      city: dto.city,
      status: CircuitPackageStatus.DRAFT,
      stops,
      ...(dto.pricing ? { pricing: this.pricingFromDto(dto.pricing) } : {}),
      rideTypes,
      ...(dto.maxPassengers ? { maxPassengers: dto.maxPassengers } : {}),
      availability: this.availabilityFromDto(dto.availability),
      ...(dto.cancellationPolicy ? { cancellationPolicy: dto.cancellationPolicy } : {}),
      ...(dto.referenceOrigin ? { referenceOrigin: dto.referenceOrigin } : {}),
      createdBy: new Types.ObjectId(adminId),
      updatedBy: new Types.ObjectId(adminId),
    });
    await this.audit.record({
      adminId,
      action: "circuit_package.create",
      targetType: "CIRCUIT_PACKAGE",
      targetId: created._id.toString(),
      targetLabel: `${created.code} ${created.name}`,
      metadata: { status: created.status, stops: stops.map((stop) => stop.name) },
    });
    return this.toAdminView(created, await this.rideTypeIndex());
  }

  /**
   * Edits any field. Stops are replaced as a whole (that is how admins reorder,
   * remove or replace one). A live package must stay publishable, so an edit
   * that would break it is refused instead of leaving customers a bad product.
   */
  async update(id: string, dto: UpdateCircuitPackageDto, adminId: string): Promise<CircuitPackageAdminView> {
    const before = await this.requirePackage(id);
    if (before.status === CircuitPackageStatus.ARCHIVED)
      throw apiConflict("An archived package cannot be edited", "CIRCUIT_PACKAGE_STATUS_INVALID");

    const set: Record<string, unknown> = { updatedBy: new Types.ObjectId(adminId) };
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    let quoteChanged = false;
    const note = (field: string, from: unknown, to: unknown, affectsQuote = false): void => {
      if (JSON.stringify(from) === JSON.stringify(to)) return;
      changes[field] = { from, to };
      quoteChanged ||= affectsQuote;
    };

    if (dto.name !== undefined) {
      note("name", before.name, dto.name);
      set.name = dto.name;
    }
    if (dto.description !== undefined) {
      note("description", before.description, dto.description);
      set.description = dto.description;
    }
    if (dto.city !== undefined) {
      note("city", before.city, dto.city);
      set.city = dto.city;
    }
    if (dto.cancellationPolicy !== undefined) {
      note("cancellationPolicy", before.cancellationPolicy, dto.cancellationPolicy);
      set.cancellationPolicy = dto.cancellationPolicy;
    }
    if (dto.referenceOrigin !== undefined) set.referenceOrigin = dto.referenceOrigin;
    if (dto.stops !== undefined) {
      const stops = await this.resolveStops(dto.stops);
      note("stops", before.stops.map((stop) => stop.name), stops.map((stop) => stop.name), true);
      set.stops = stops;
    }
    if (dto.pricing !== undefined) {
      const pricing = this.pricingFromDto(dto.pricing);
      note("pricing", before.pricing ? pricingView(before.pricing) : undefined, pricingView(pricing), true);
      set.pricing = pricing;
    }
    if (dto.rideTypes !== undefined) {
      const rideTypes = await this.assertRideTypes(dto.rideTypes);
      note("rideTypes", before.rideTypes, rideTypes, true);
      set.rideTypes = rideTypes;
    }
    if (dto.maxPassengers !== undefined) {
      note("maxPassengers", before.maxPassengers, dto.maxPassengers, true);
      set.maxPassengers = dto.maxPassengers;
    }
    if (dto.availability !== undefined) {
      const availability = this.availabilityFromDto(dto.availability, before.availability);
      note("availability", availabilityView(before), availabilityView({ ...before.toObject(), availability } as CircuitPackage), true);
      set.availability = availability;
    }

    if (Object.keys(changes).length === 0 && dto.referenceOrigin === undefined) return this.toAdminView(before, await this.rideTypeIndex());

    // A live package must remain publishable after the edit.
    if (before.status === CircuitPackageStatus.ACTIVE) {
      const merged = { ...before.toObject(), ...set } as unknown as CircuitPackage;
      await this.assertPublishable(merged);
    }

    const updated = await this.packages
      .findOneAndUpdate(
        { _id: before._id, revision: before.revision },
        { $set: set, ...(quoteChanged ? { $inc: { revision: 1 } } : {}) },
        { returnDocument: "after", runValidators: true },
      )
      .select("-cover.data")
      .exec();
    if (!updated) throw apiConflict("This package was changed by someone else. Reload and try again.", "CIRCUIT_PACKAGE_STATUS_INVALID");

    if (Object.keys(changes).length)
      await this.audit.record({
        adminId,
        action: "circuit_package.update",
        targetType: "CIRCUIT_PACKAGE",
        targetId: updated._id.toString(),
        targetLabel: `${updated.code} ${updated.name}`,
        reason: dto.reason,
        metadata: { changes, fields: Object.keys(changes), revision: updated.revision, status: updated.status },
      });
    return this.toAdminView(updated, await this.rideTypeIndex());
  }

  /** Publishing (→ ACTIVE) runs every rule; the other moves only need to be legal. */
  async setStatus(id: string, status: CircuitPackageStatus, adminId: string, reason?: string): Promise<CircuitPackageAdminView> {
    const pkg = await this.requirePackage(id);
    if (!PACKAGE_STATUS_TRANSITIONS[pkg.status].includes(status))
      throw apiConflict(`A ${pkg.status.toLowerCase()} package cannot become ${status.toLowerCase()}`, "CIRCUIT_PACKAGE_STATUS_INVALID");
    if (status === CircuitPackageStatus.ACTIVE) await this.assertPublishable(pkg);

    const updated = await this.packages
      .findOneAndUpdate(
        { _id: pkg._id, status: pkg.status },
        {
          $set: {
            status,
            updatedBy: new Types.ObjectId(adminId),
            ...(status === CircuitPackageStatus.ACTIVE && !pkg.publishedAt ? { publishedAt: new Date() } : {}),
          },
        },
        { returnDocument: "after" },
      )
      .select("-cover.data")
      .exec();
    if (!updated) throw apiConflict("This package was changed by someone else. Reload and try again.", "CIRCUIT_PACKAGE_STATUS_INVALID");

    await this.audit.record({
      adminId,
      action: "circuit_package.status",
      targetType: "CIRCUIT_PACKAGE",
      targetId: updated._id.toString(),
      targetLabel: `${updated.code} ${updated.name}`,
      reason,
      metadata: { from: pkg.status, to: status },
    });
    return this.toAdminView(updated, await this.rideTypeIndex());
  }

  /** Only a draft that nobody ever booked can be removed; everything else is archived. */
  async remove(id: string, adminId: string): Promise<void> {
    const pkg = await this.requirePackage(id);
    if (pkg.status !== CircuitPackageStatus.DRAFT || pkg.hasBookings)
      throw apiConflict("Only an unused draft can be deleted. Archive the package instead.", "CIRCUIT_PACKAGE_HAS_BOOKINGS");
    await this.packages.deleteOne({ _id: pkg._id, status: CircuitPackageStatus.DRAFT, hasBookings: false }).exec();
    await this.audit.record({
      adminId,
      action: "circuit_package.delete",
      targetType: "CIRCUIT_PACKAGE",
      targetId: pkg._id.toString(),
      targetLabel: `${pkg.code} ${pkg.name}`,
    });
  }

  async setCover(id: string, upload: { buffer: Buffer }, adminId: string): Promise<CircuitPackageAdminView> {
    const image = probeImage(upload.buffer);
    const problem = imageProblem(upload.buffer.length, image);
    if (problem || !image)
      throw apiBadRequest(problem ?? "Unsupported image", "CIRCUIT_PACKAGE_INVALID_IMAGE", { hint: CIRCUIT_COVER_RULE.hint });
    const pkg = await this.requirePackage(id);
    const updated = await this.packages
      .findByIdAndUpdate(
        pkg._id,
        {
          $set: {
            cover: {
              contentType: image.contentType,
              data: upload.buffer,
              version: createHash("sha1").update(upload.buffer).digest("hex").slice(0, 12),
              width: image.width,
              height: image.height,
              bytes: upload.buffer.length,
            },
            updatedBy: new Types.ObjectId(adminId),
          },
        },
        { returnDocument: "after" },
      )
      .select("-cover.data")
      .exec();
    await this.audit.record({
      adminId,
      action: "circuit_package.cover_set",
      targetType: "CIRCUIT_PACKAGE",
      targetId: pkg._id.toString(),
      targetLabel: `${pkg.code} ${pkg.name}`,
    });
    return this.toAdminView(updated ?? pkg, await this.rideTypeIndex());
  }

  async removeCover(id: string, adminId: string): Promise<CircuitPackageAdminView> {
    const pkg = await this.requirePackage(id);
    const updated = await this.packages
      .findByIdAndUpdate(pkg._id, { $unset: { cover: 1 }, $set: { updatedBy: new Types.ObjectId(adminId) } }, { returnDocument: "after" })
      .select("-cover.data")
      .exec();
    await this.audit.record({
      adminId,
      action: "circuit_package.cover_removed",
      targetType: "CIRCUIT_PACKAGE",
      targetId: pkg._id.toString(),
      targetLabel: `${pkg.code} ${pkg.name}`,
    });
    return this.toAdminView(updated ?? pkg, await this.rideTypeIndex());
  }

  /** Public (cover images are marketing material); only an ACTIVE or INACTIVE package's cover is served. */
  async coverFile(id: string): Promise<CoverFile> {
    const pkg = Types.ObjectId.isValid(id) ? await this.packages.findById(id).select("+cover.data status").exec() : null;
    if (!pkg?.cover || pkg.status === CircuitPackageStatus.DRAFT)
      throw apiNotFound("This package has no cover image", "CIRCUIT_PACKAGE_NOT_FOUND");
    return { data: pkg.cover.data, contentType: pkg.cover.contentType, version: pkg.cover.version };
  }

  /** Admin-side place search so stops are always picked from the Maps provider. */
  placeSearch(query: string, sessionToken?: string) {
    return this.places.autocomplete({ query, sessionToken, limit: 8 });
  }

  placeResolve(id: string, sessionToken?: string) {
    return this.places.resolve(id, sessionToken);
  }

  /**
   * Stop → stop route through the shared maps provider: the legs, their total,
   * and a warning when the configured included distance cannot even cover the
   * stops themselves. The customer's pickup leg is extra and unknown here, so
   * an optional reference origin gives Admin a realistic first leg.
   */
  async routePreview(id: string, dto: RoutePreviewDto): Promise<RoutePreviewView> {
    const pkg = await this.requirePackage(id);
    // Plain copies: spreading a hydrated subdocument loses its fields.
    const stops: StopSnapshot[] = dto.stops
      ? await this.resolveStops(dto.stops)
      : pkg.stops.map((stop) => ({ order: stop.order, placeId: stop.placeId, name: stop.name, address: stop.address, latitude: stop.latitude, longitude: stop.longitude }));
    if (stops.length < 2) throw apiBadRequest("Add at least two stops to preview the route", "CIRCUIT_PACKAGE_INVALID");

    const legResults = await Promise.all(
      stops.slice(1).map((stop, index) => this.locations.routeBetween(stops[index], stop)),
    );
    const legs = legResults.map((route, index) => ({
      from: stops[index].name,
      to: stops[index + 1].name,
      distanceMeters: route.distanceMeters,
      durationSeconds: route.durationSeconds,
      provider: route.provider,
    }));
    const stopsDistanceMeters = legs.reduce((sum, leg) => sum + leg.distanceMeters, 0);
    const stopsDurationSeconds = legs.reduce((sum, leg) => sum + leg.durationSeconds, 0);

    const origin = pkg.referenceOrigin;
    const originRoute = origin ? await this.locations.routeBetween(origin, stops[0]) : undefined;
    const includedMeters =
      dto.includedDistanceKm !== undefined ? dto.includedDistanceKm * 1000 : pkg.pricing?.includedDistanceMeters;

    const warnings: string[] = [];
    if (includedMeters !== undefined) {
      const total = stopsDistanceMeters + (originRoute?.distanceMeters ?? 0);
      const warning = distanceWarning(includedMeters, total);
      if (warning)
        warnings.push(
          originRoute ? `${warning.replace("the stops' own route", "the route from the reference origin through the stops")}` : warning,
        );
    }
    if (legs.some((leg) => leg.provider !== "GOOGLE_ROUTES"))
      warnings.push("Some distances are straight-line estimates because road routing was unavailable.");

    return {
      legs,
      stopsDistanceMeters,
      stopsDurationSeconds,
      originLeg: originRoute
        ? { distanceMeters: originRoute.distanceMeters, durationSeconds: originRoute.durationSeconds, provider: originRoute.provider }
        : undefined,
      polyline: joinLegs(
        legResults.map((route, index) => ({ from: stops[index], to: stops[index + 1], polyline: route.polyline })),
      ),
      warnings,
    };
  }

  // ── Customer ──────────────────────────────────────────────────────────

  /** Active packages in season, in a stable order. Availability right now is a flag, not a filter. */
  async listForCustomers(city?: string, now = new Date()): Promise<CircuitPackageCustomerView[]> {
    const filter: QueryFilter<CircuitPackage> = { status: CircuitPackageStatus.ACTIVE };
    if (city) filter.city = { $regex: `^${escapeRegex(city)}$`, $options: "i" };
    const [rows, rideTypes] = await Promise.all([
      this.packages.find(filter).select("-cover.data").sort({ city: 1, name: 1 }).exec(),
      this.rideTypeIndex(),
    ]);
    return rows
      .filter((row) => !this.isPastSeason(row, now))
      .map((row) => this.toCustomerView(row, rideTypes, now))
      .filter((view): view is CircuitPackageCustomerView => view !== null);
  }

  async getForCustomer(id: string, now = new Date()): Promise<CircuitPackageCustomerView> {
    const pkg = await this.findActive(id);
    const view = this.toCustomerView(pkg, await this.rideTypeIndex(), now);
    if (!view) throw apiNotFound("Circuit not found", "CIRCUIT_PACKAGE_NOT_FOUND");
    return view;
  }

  /** For booking: the package must be ACTIVE, and the caller applies availability + vehicle rules. */
  async findActive(id: string): Promise<CircuitPackageDocument> {
    const pkg = Types.ObjectId.isValid(id) ? await this.packages.findById(id).select("-cover.data").exec() : null;
    if (!pkg || pkg.status !== CircuitPackageStatus.ACTIVE) throw apiNotFound("Circuit not found", "CIRCUIT_PACKAGE_NOT_FOUND");
    return pkg;
  }

  /** The booking rules shared by estimate and booking: availability, vehicle and capacity. */
  async assertBookable(
    pkg: CircuitPackageDocument,
    rideType: { code: string; displayName: string; seatCapacity: number },
    passengers: number,
    now = new Date(),
  ): Promise<void> {
    const verdict = checkAvailability(pkg.availability as AvailabilityRule, now, this.timeZone);
    if (!verdict.open) throw apiBadRequest(verdict.message, "CIRCUIT_PACKAGE_UNAVAILABLE", { reason: verdict.reason });
    if (!pkg.rideTypes.includes(rideType.code))
      throw apiBadRequest(`${rideType.displayName} is not available for ${pkg.name}`, "CIRCUIT_VEHICLE_NOT_ALLOWED");
    const capacity = effectiveCapacity(pkg.maxPassengers, rideType.seatCapacity);
    if (passengers > capacity)
      throw apiBadRequest(`${rideType.displayName} can carry at most ${capacity} passengers on this circuit`, "CIRCUIT_PASSENGERS_EXCEEDED", {
        maxPassengers: capacity,
      });
  }

  /** Once any customer has booked it, a package can be archived but never deleted. */
  async markBooked(id: Types.ObjectId): Promise<void> {
    await this.packages.updateOne({ _id: id, hasBookings: false }, { $set: { hasBookings: true } }).exec();
  }

  // ── Internals ─────────────────────────────────────────────────────────

  private async requirePackage(id: string): Promise<CircuitPackageDocument> {
    const pkg = Types.ObjectId.isValid(id) ? await this.packages.findById(id).select("-cover.data").exec() : null;
    if (!pkg) throw apiNotFound("Circuit package not found", "CIRCUIT_PACKAGE_NOT_FOUND");
    return pkg;
  }

  private isPastSeason(pkg: CircuitPackage, now: Date): boolean {
    const { validUntil } = pkg.availability;
    if (!validUntil) return false;
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: this.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
    return today > validUntil;
  }

  private async rideTypeIndex(): Promise<Map<string, { code: string; displayName: string; icon: string; seatCapacity: number; isActive: boolean }>> {
    const all = await this.rideTypes.listAll();
    return new Map(all.map((type) => [type.code, type]));
  }

  private async assertRideTypes(codes: string[]): Promise<string[]> {
    const index = await this.rideTypeIndex();
    const unknown = codes.filter((code) => !index.has(code));
    if (unknown.length) throw apiBadRequest(`Unknown ride type: ${unknown.join(", ")}`, "CIRCUIT_PACKAGE_INVALID");
    return [...new Set(codes)];
  }

  private async assertPublishable(pkg: CircuitPackage): Promise<void> {
    const problems = publishProblems(pkg as never, await this.rideTypeIndex());
    if (problems.length)
      throw apiBadRequest(`This package cannot be published: ${problems[0].message}`, "CIRCUIT_PACKAGE_NOT_PUBLISHABLE", { problems });
  }

  /** Server-resolved stops: coordinates, address and name always come from the places provider. */
  private async resolveStops(inputs: CircuitStopInputDto[]): Promise<StopSnapshot[]> {
    const resolved = await Promise.all(inputs.map((input) => this.places.resolve(input.placeId)));
    return resolved.map((place, index) => ({
      order: index + 1,
      placeId: inputs[index].placeId,
      name: inputs[index].name ?? place.name,
      address: place.address,
      latitude: place.latitude,
      longitude: place.longitude,
    }));
  }

  private pricingFromDto(dto: NonNullable<CreateCircuitPackageDto["pricing"]>): NonNullable<CircuitPackage["pricing"]> {
    return {
      basePrice: dto.basePrice,
      includedDistanceMeters: Math.round(dto.includedDistanceKm * 1000),
      includedDurationSeconds: Math.round(dto.includedDurationHours * 3600),
      extraDistanceRatePerKm: dto.extraDistanceRatePerKm,
      extraDurationRatePerHour: dto.extraDurationRatePerHour,
    };
  }

  private availabilityFromDto(
    dto: CreateCircuitPackageDto["availability"],
    current?: CircuitPackage["availability"],
  ): CircuitPackage["availability"] {
    const base = { days: current?.days ?? [0, 1, 2, 3, 4, 5, 6], opensAt: current?.opensAt ?? "06:00", closesAt: current?.closesAt ?? "20:00" };
    const next = {
      ...base,
      ...(dto?.days ? { days: [...dto.days].sort((a, b) => a - b) } : {}),
      ...(dto?.opensAt ? { opensAt: dto.opensAt } : {}),
      ...(dto?.closesAt ? { closesAt: dto.closesAt } : {}),
    } as CircuitPackage["availability"];
    // null clears a season bound; undefined keeps it.
    const bound = (key: "validFrom" | "validUntil"): string | undefined => {
      const given = dto?.[key];
      return given === null ? undefined : (given ?? current?.[key] ?? undefined);
    };
    const validFrom = bound("validFrom");
    const validUntil = bound("validUntil");
    if (validFrom) next.validFrom = validFrom;
    if (validUntil) next.validUntil = validUntil;
    return next;
  }

  private toAdminView(
    pkg: CircuitPackageDocument,
    rideTypes: Map<string, { seatCapacity: number }>,
  ): CircuitPackageAdminView {
    return {
      id: pkg._id.toString(),
      code: pkg.code,
      name: pkg.name,
      description: pkg.description ?? "",
      city: pkg.city,
      status: pkg.status,
      stops: [...pkg.stops].sort((a, b) => a.order - b.order).map(stopView),
      pricing: pkg.pricing ? pricingView(pkg.pricing) : undefined,
      rideTypes: pkg.rideTypes,
      maxPassengers: pkg.maxPassengers,
      availability: availabilityView(pkg),
      cancellationPolicy: pkg.cancellationPolicy,
      referenceOrigin: pkg.referenceOrigin
        ? { label: pkg.referenceOrigin.label, latitude: pkg.referenceOrigin.latitude, longitude: pkg.referenceOrigin.longitude }
        : undefined,
      coverPath: coverPath(pkg),
      revision: pkg.revision,
      hasBookings: pkg.hasBookings,
      publishProblems: publishProblems(pkg as never, rideTypes as never),
      publishedAt: pkg.publishedAt,
      createdAt: pkg.get("createdAt") as Date,
      updatedAt: pkg.get("updatedAt") as Date,
    };
  }

  private toCustomerView(
    pkg: CircuitPackageDocument,
    rideTypes: Map<string, { code: string; displayName: string; icon: string; seatCapacity: number; isActive: boolean }>,
    now: Date,
  ): CircuitPackageCustomerView | null {
    if (!pkg.pricing) return null;
    const verdict = checkAvailability(pkg.availability as AvailabilityRule, now, this.timeZone);
    const vehicles = pkg.rideTypes
      .map((code) => rideTypes.get(code))
      .filter((type): type is NonNullable<typeof type> => !!type?.isActive)
      .map((type) => ({
        rideType: type.code,
        displayName: type.displayName,
        icon: type.icon,
        seatCapacity: type.seatCapacity,
        maxPassengers: effectiveCapacity(pkg.maxPassengers, type.seatCapacity),
      }));
    if (vehicles.length === 0) return null;
    return {
      id: pkg._id.toString(),
      code: pkg.code,
      name: pkg.name,
      description: pkg.description ?? "",
      city: pkg.city,
      stops: [...pkg.stops].sort((a, b) => a.order - b.order).map(stopView),
      pricing: pricingView(pkg.pricing),
      vehicles,
      maxPassengers: Math.max(...vehicles.map((vehicle) => vehicle.maxPassengers)),
      availability: availabilityView(pkg),
      availableNow: verdict.open,
      unavailableReason: verdict.open ? undefined : verdict.message,
      cancellationPolicy: pkg.cancellationPolicy,
      coverPath: coverPath(pkg),
    };
  }

  private async nextCode(): Promise<string> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const counter = await this.counters
          .findOneAndUpdate({ _id: "circuit_package" }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: "after" })
          .exec();
        return `CIR-${String(counter.seq).padStart(3, "0")}`;
      } catch (error) {
        // Two instances racing the first upsert: the loser just retries.
        if (!isDuplicateKey(error)) throw error;
      }
    }
    throw new Error("Could not allocate a circuit package code");
  }
}
