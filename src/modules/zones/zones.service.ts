import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import type { Model, QueryFilter } from "mongoose";
import { Types } from "mongoose";
import { apiBadRequest, apiConflict, apiNotFound } from "../../common/exceptions/api.exception";
import { toGeoJsonPoint } from "../locations/geo";
import type { GeoCoordinates } from "../locations/geo";
import type { Page } from "../rides/rides.service";
import type { CreateZoneDto, UpdateZoneDto } from "./dto/zone.dto";
import { Zone, ZoneStatus } from "./schemas/zone.schema";
import type { ZoneDocument } from "./schemas/zone.schema";
import { ZoneGeometryError, pointsFromPolygon, polygonFromPoints } from "./zone-geometry";
import type { GeoJsonPolygon } from "./zone-geometry";

export interface ZoneView {
  id: string;
  name: string;
  city?: string;
  description?: string;
  status: ZoneStatus;
  boundary: GeoCoordinates[];
  vertexCount: number;
  createdAt: Date;
  updatedAt: Date;
}

/** What a ride remembers about its pickup zone. */
export interface ZoneRef {
  zoneId: Types.ObjectId;
  zoneName: string;
}

export interface ServiceAreaCheck {
  /** False only when zones are in force and the point is outside all of them. */
  serviceable: boolean;
  zone: ZoneRef | null;
}

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isDuplicateKey = (error: unknown): boolean => (error as { code?: number } | undefined)?.code === 11000;
/** MongoDB refusing to index a polygon ("Can't extract geo keys", "Loop is not valid"). */
const isGeoIndexError = (error: unknown): boolean => [16755, 16433].includes((error as { code?: number })?.code ?? -1);

@Injectable()
export class ZonesService {
  constructor(@InjectModel(Zone.name) private readonly zoneModel: Model<Zone>) {}

  toView(zone: ZoneDocument): ZoneView {
    const boundary = pointsFromPolygon(zone.boundary as GeoJsonPolygon);
    return {
      id: zone._id.toString(),
      name: zone.name,
      city: zone.city,
      description: zone.description,
      status: zone.status,
      boundary,
      vertexCount: boundary.length,
      createdAt: zone.get("createdAt") as Date,
      updatedAt: zone.get("updatedAt") as Date,
    };
  }

  async list(query: { page: number; limit: number; status?: ZoneStatus; search?: string }): Promise<Page<ZoneView>> {
    const filter: QueryFilter<Zone> = {};
    if (query.status) filter.status = query.status;
    if (query.search) {
      const pattern = { $regex: escapeRegex(query.search.trim()), $options: "i" };
      filter.$or = [{ name: pattern }, { city: pattern }];
    }
    const [zones, total] = await Promise.all([
      this.zoneModel
        .find(filter)
        .sort({ status: 1, name: 1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .exec(),
      this.zoneModel.countDocuments(filter).exec(),
    ]);
    return {
      items: zones.map((zone) => this.toView(zone)),
      page: query.page,
      limit: query.limit,
      total,
      hasMore: query.page * query.limit < total,
    };
  }

  async listActive(): Promise<ZoneDocument[]> {
    return this.zoneModel.find({ status: ZoneStatus.ACTIVE }).sort({ name: 1 }).exec();
  }

  async get(id: string): Promise<ZoneDocument> {
    const zone = await this.zoneModel.findById(id).exec();
    if (!zone) throw apiNotFound("Zone not found", "ZONE_NOT_FOUND");
    return zone;
  }

  async create(dto: CreateZoneDto, adminUserId: string): Promise<ZoneDocument> {
    const boundary = this.polygon(dto.boundary);
    return this.persist(() =>
      this.zoneModel.create({
        name: dto.name.trim(),
        nameKey: dto.name.trim().toLowerCase(),
        city: dto.city,
        description: dto.description,
        status: dto.status ?? ZoneStatus.ACTIVE,
        boundary,
        createdBy: new Types.ObjectId(adminUserId),
        updatedBy: new Types.ObjectId(adminUserId),
      }),
    );
  }

  async update(id: string, dto: UpdateZoneDto, adminUserId: string): Promise<ZoneDocument> {
    const zone = await this.get(id);
    if (dto.name !== undefined) {
      zone.name = dto.name.trim();
      zone.nameKey = zone.name.toLowerCase();
    }
    if (dto.city !== undefined) zone.city = dto.city || undefined;
    if (dto.description !== undefined) zone.description = dto.description || undefined;
    if (dto.boundary !== undefined) {
      zone.boundary = this.polygon(dto.boundary);
      zone.markModified("boundary");
    }
    zone.updatedBy = new Types.ObjectId(adminUserId);
    return this.persist(() => zone.save());
  }

  async setStatus(id: string, status: ZoneStatus, adminUserId: string): Promise<{ zone: ZoneDocument; changed: boolean }> {
    const zone = await this.get(id);
    if (zone.status === status) return { zone, changed: false };
    zone.status = status;
    zone.updatedBy = new Types.ObjectId(adminUserId);
    await zone.save();
    return { zone, changed: true };
  }

  /** The active zone containing a point, if any (smallest name first on overlap). */
  async findActiveZoneFor(point: GeoCoordinates): Promise<ZoneRef | null> {
    const zone = await this.zoneModel
      .findOne({
        status: ZoneStatus.ACTIVE,
        boundary: { $geoIntersects: { $geometry: toGeoJsonPoint(point) } },
      })
      .sort({ name: 1 })
      .select("_id name")
      .lean()
      .exec();
    return zone ? { zoneId: zone._id, zoneName: zone.name } : null;
  }

  /**
   * Service availability rule: with no active zone defined, Tirvona serves
   * everywhere (the pre-zones behaviour). Once at least one zone is active,
   * a pickup must lie inside an active zone.
   */
  async checkServiceArea(pickup: GeoCoordinates): Promise<ServiceAreaCheck> {
    const zone = await this.findActiveZoneFor(pickup);
    if (zone) return { serviceable: true, zone };
    const zonesInForce = (await this.zoneModel.exists({ status: ZoneStatus.ACTIVE })) !== null;
    return { serviceable: !zonesInForce, zone: null };
  }

  async assertServiceable(pickup: GeoCoordinates): Promise<ZoneRef | null> {
    const check = await this.checkServiceArea(pickup);
    if (!check.serviceable)
      throw apiBadRequest(
        "Tirvona Rides is not available at this pickup point yet. Please choose a pickup inside our service area.",
        "SERVICE_AREA_UNAVAILABLE",
      );
    return check.zone;
  }

  private polygon(points: GeoCoordinates[]): GeoJsonPolygon {
    try {
      return polygonFromPoints(points);
    } catch (error) {
      if (error instanceof ZoneGeometryError) throw apiBadRequest(error.message, "ZONE_INVALID_BOUNDARY");
      throw error;
    }
  }

  private async persist(write: () => Promise<ZoneDocument>): Promise<ZoneDocument> {
    try {
      return await write();
    } catch (error) {
      if (isDuplicateKey(error)) throw apiConflict("A zone with this name already exists", "ZONE_ALREADY_EXISTS");
      if (isGeoIndexError(error))
        throw apiBadRequest("MongoDB could not index this boundary — check it does not cross itself", "ZONE_INVALID_BOUNDARY");
      throw error;
    }
  }
}
