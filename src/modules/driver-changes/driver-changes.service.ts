import { Injectable, Logger } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Types } from "mongoose";
import type { Model } from "mongoose";
import { apiBadRequest, apiConflict, apiNotFound } from "../../common/exceptions/api.exception";
import { removeFile, storeUpload } from "../../common/http/file-upload";
import { DocumentStatus } from "../../common/types/document-status.enum";
import { DomainEventsService } from "../../infrastructure/events/domain-events.service";
import { DriverDocument, DriverDocumentType } from "../drivers/schemas/driver-document.schema";
import { DriverProfile, DriverStatus } from "../drivers/schemas/driver-profile.schema";
import type { DriverProfileDocument } from "../drivers/schemas/driver-profile.schema";
import type { Page } from "../rides/rides.service";
import { User } from "../users/schemas/user.schema";
import { VehicleDocument, VehicleDocumentType } from "../vehicles/schemas/vehicle-document.schema";
import { Vehicle } from "../vehicles/schemas/vehicle.schema";
import type { VehicleDocument as VehicleDoc } from "../vehicles/schemas/vehicle.schema";
import type { DocumentChangeDto, DriverProfileChangeDto, VehicleChangeDto } from "./dto/driver-change.dto";
import { DriverChangeKind, DriverChangeRequest, DriverChangeStatus } from "./schemas/driver-change-request.schema";
import type { DriverChangeRequestDocument } from "./schemas/driver-change-request.schema";

/** Driver statuses that may ask for changes to verified details. */
const CAN_REQUEST: DriverStatus[] = [DriverStatus.APPROVED, DriverStatus.SUSPENDED];

/** Recent history shown in the app next to the pending requests. */
const HISTORY_LIMIT = 30;

const DOCUMENT_LABELS: Record<string, string> = {
  [DriverDocumentType.DRIVING_LICENSE]: "Driving licence",
  [DriverDocumentType.AADHAAR]: "Aadhaar card",
  [DriverDocumentType.PAN]: "PAN card",
  [DriverDocumentType.PROFILE_PHOTO]: "Profile photo",
  [DriverDocumentType.ADDRESS_PROOF]: "Address proof",
  [VehicleDocumentType.RC]: "Registration certificate (RC)",
  [VehicleDocumentType.INSURANCE]: "Vehicle insurance",
  [VehicleDocumentType.PERMIT]: "Permit",
  [VehicleDocumentType.POLLUTION_CERTIFICATE]: "Pollution certificate (PUC)",
};

/** API field name → vehicle schema field. */
const VEHICLE_FIELDS = {
  vehicleType: "vehicleType",
  registrationNumber: "registrationNumber",
  make: "make",
  model: "vehicleModel",
  color: "color",
  manufactureYear: "manufactureYear",
} as const;

const PROFILE_DATE_FIELDS = new Set(["licenseExpiry", "dateOfBirth"]);

/** The fields driver_documents and vehicle_documents have in common. */
interface DocumentRecord {
  driverId?: Types.ObjectId;
  vehicleId?: Types.ObjectId;
  documentType: string;
  documentNumber?: string;
  filePath: string;
  status: DocumentStatus;
  expiryDate?: Date;
  verifiedBy?: Types.ObjectId;
  verifiedAt?: Date;
}

export interface DriverChangeView {
  id: string;
  kind: DriverChangeKind;
  /** "Driving licence", "Vehicle details", … — for lists and notifications. */
  label: string;
  status: DriverChangeStatus;
  vehicleId?: string;
  documentType?: string;
  changes: Record<string, unknown>;
  previous: Record<string, unknown>;
  hasFile: boolean;
  reviewNote?: string;
  submittedAt: Date;
  reviewedAt?: Date;
}

export interface AdminDriverChangeView extends DriverChangeView {
  driver: { id: string; driverCode: string; driverStatus: DriverStatus; name: string; phone: string };
}

export interface DriverChangesOverview {
  pending: DriverChangeView[];
  /** Decided or withdrawn, newest first. */
  history: DriverChangeView[];
}

const isDuplicateKey = (error: unknown): boolean => (error as { code?: number } | undefined)?.code === 11000;

const sameValue = (a: unknown, b: unknown): boolean => {
  if (a instanceof Date || b instanceof Date)
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  return (a ?? null) === (b ?? null);
};

const calendarDate = (value: string): Date => new Date(`${value.slice(0, 10)}T00:00:00.000Z`);

const startOfTodayUtc = (): number => {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
};

/**
 * Changes to verified driver details after approval. The driver submits;
 * the live records stay as verified until an admin approves, when the
 * change is applied; a rejection leaves everything as it was and tells the
 * driver why. Every decision is audited and notified.
 */
@Injectable()
export class DriverChangesService {
  private readonly logger = new Logger(DriverChangesService.name);

  constructor(
    @InjectModel(DriverChangeRequest.name) private readonly requests: Model<DriverChangeRequest>,
    @InjectModel(DriverProfile.name) private readonly drivers: Model<DriverProfile>,
    @InjectModel(DriverDocument.name) private readonly driverDocuments: Model<DriverDocument>,
    @InjectModel(Vehicle.name) private readonly vehicles: Model<Vehicle>,
    @InjectModel(VehicleDocument.name) private readonly vehicleDocuments: Model<VehicleDocument>,
    @InjectModel(User.name) private readonly users: Model<User>,
    private readonly domainEvents: DomainEventsService,
  ) {}

  // ── Driver side ────────────────────────────────────────────────────────

  async overview(userId: string, status?: DriverChangeStatus): Promise<DriverChangesOverview> {
    const driver = await this.driverFor(userId);
    const filter = { driverId: driver._id, ...(status ? { status } : {}) };
    const rows = await this.requests.find(filter).sort({ createdAt: -1 }).limit(HISTORY_LIMIT + 50).exec();
    const views = rows.map((row) => this.toView(row));
    return {
      pending: views.filter((view) => view.status === DriverChangeStatus.PENDING),
      history: views.filter((view) => view.status !== DriverChangeStatus.PENDING).slice(0, HISTORY_LIMIT),
    };
  }

  async requestProfileChange(userId: string, dto: DriverProfileChangeDto): Promise<DriverChangeView> {
    const driver = await this.requesterFor(userId);
    const requested: Record<string, unknown> = {};
    if (dto.licenseNumber !== undefined) requested.licenseNumber = dto.licenseNumber.toUpperCase();
    if (dto.licenseExpiry !== undefined) {
      const expiry = calendarDate(dto.licenseExpiry);
      if (expiry.getTime() <= startOfTodayUtc())
        throw apiBadRequest("The licence expiry date must be in the future", "VALIDATION_FAILED");
      requested.licenseExpiry = expiry;
    }
    if (dto.dateOfBirth !== undefined) {
      const dob = calendarDate(dto.dateOfBirth);
      if (dob.getTime() >= Date.now() || dob.getUTCFullYear() < 1900)
        throw apiBadRequest("Enter a real date of birth", "VALIDATION_FAILED");
      requested.dateOfBirth = dob;
    }
    const current: Record<string, unknown> = {
      licenseNumber: driver.licenseNumber,
      licenseExpiry: driver.licenseExpiry,
      dateOfBirth: driver.dateOfBirth,
    };
    const { changes, previous } = this.diff(requested, current);
    return this.upsertPending(driver, {
      kind: DriverChangeKind.DRIVER_PROFILE,
      targetKey: "profile",
      changes,
      previous,
    });
  }

  async requestVehicleChange(userId: string, dto: VehicleChangeDto): Promise<DriverChangeView> {
    const driver = await this.requesterFor(userId);
    const vehicle = await this.activeVehicle(driver, dto.vehicleId);
    const requested: Record<string, unknown> = {};
    const current: Record<string, unknown> = {};
    for (const [apiField, schemaField] of Object.entries(VEHICLE_FIELDS)) {
      const value = dto[apiField as keyof typeof VEHICLE_FIELDS];
      if (value !== undefined) requested[apiField] = value;
      current[apiField] = vehicle[schemaField];
    }
    const { changes, previous } = this.diff(requested, current);
    if (typeof changes.registrationNumber === "string") await this.assertPlateFree(changes.registrationNumber, vehicle._id);
    return this.upsertPending(driver, {
      kind: DriverChangeKind.VEHICLE,
      targetKey: `vehicle:${vehicle._id.toHexString()}`,
      vehicleId: vehicle._id,
      changes,
      previous,
    });
  }

  /** A new or renewed document; `file` is the multer temp upload. */
  async requestDocumentChange(userId: string, dto: DocumentChangeDto, file: Express.Multer.File): Promise<DriverChangeView> {
    const driver = await this.requesterFor(userId);
    const isVehicle = dto.scope === "VEHICLE";
    const types: string[] = Object.values(isVehicle ? VehicleDocumentType : DriverDocumentType);
    if (!types.includes(dto.documentType))
      throw apiBadRequest(`${dto.documentType} is not a ${isVehicle ? "vehicle" : "driver"} document`, "DOCUMENT_INVALID_TYPE");

    let expiryDate: Date | undefined;
    if (dto.expiryDate) {
      expiryDate = calendarDate(dto.expiryDate);
      if (expiryDate.getTime() <= startOfTodayUtc())
        throw apiBadRequest("The document's expiry date must be in the future", "VALIDATION_FAILED");
    }

    const vehicle = isVehicle ? await this.activeVehicle(driver, dto.vehicleId ?? "") : undefined;
    const existing: { _id: Types.ObjectId; documentNumber?: string; expiryDate?: Date; status: DocumentStatus } | null =
      vehicle
        ? await this.vehicleDocuments
            .findOne({ vehicleId: vehicle._id, documentType: dto.documentType as VehicleDocumentType })
            .lean()
            .exec()
        : await this.driverDocuments
            .findOne({ driverId: driver._id, documentType: dto.documentType as DriverDocumentType })
            .lean()
            .exec();

    const filePath = await storeUpload(file, "driver-changes", driver._id.toHexString());
    try {
      return await this.upsertPending(driver, {
        kind: isVehicle ? DriverChangeKind.VEHICLE_DOCUMENT : DriverChangeKind.DRIVER_DOCUMENT,
        targetKey: vehicle ? `vdoc:${vehicle._id.toHexString()}:${dto.documentType}` : `doc:${dto.documentType}`,
        vehicleId: vehicle?._id,
        documentType: dto.documentType,
        changes: {
          ...(dto.documentNumber ? { documentNumber: dto.documentNumber } : {}),
          ...(expiryDate ? { expiryDate } : {}),
        },
        previous: existing
          ? {
              documentId: existing._id.toHexString(),
              documentNumber: existing.documentNumber,
              expiryDate: existing.expiryDate,
              status: existing.status,
            }
          : {},
        filePath,
      });
    } catch (error) {
      await removeFile(filePath);
      throw error;
    }
  }

  /** Takes back a request that has not been reviewed yet. */
  async withdraw(userId: string, requestId: string): Promise<DriverChangeView> {
    const driver = await this.driverFor(userId);
    const request = await this.requests
      .findOneAndUpdate(
        { _id: requestId, driverId: driver._id, status: DriverChangeStatus.PENDING },
        { $set: { status: DriverChangeStatus.WITHDRAWN }, $unset: { filePath: 1 } },
        { returnDocument: "before" },
      )
      .select("+filePath")
      .exec();
    if (!request) {
      const exists = await this.requests.exists({ _id: requestId, driverId: driver._id });
      if (!exists) throw this.notFound();
      throw apiConflict("This change has already been reviewed", "DRIVER_CHANGE_NOT_PENDING");
    }
    if (request.filePath) await removeFile(request.filePath);
    request.status = DriverChangeStatus.WITHDRAWN;
    return this.toView(request);
  }

  async fileForDriver(userId: string, requestId: string): Promise<string> {
    const driver = await this.driverFor(userId);
    return this.fileOf({ _id: requestId, driverId: driver._id });
  }

  // ── Admin side ─────────────────────────────────────────────────────────

  async listForAdmin(query: {
    status: DriverChangeStatus;
    driverId?: string;
    page: number;
    limit: number;
  }): Promise<Page<AdminDriverChangeView>> {
    const filter = {
      status: query.status,
      ...(query.driverId ? { driverId: new Types.ObjectId(query.driverId) } : {}),
    };
    // The queue works oldest first; decided lists read newest first.
    const sort: Record<string, 1 | -1> =
      query.status === DriverChangeStatus.PENDING ? { createdAt: 1 } : { reviewedAt: -1 };
    const [rows, total] = await Promise.all([
      this.requests
        .find(filter)
        .sort({ ...sort, _id: 1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .exec(),
      this.requests.countDocuments(filter).exec(),
    ]);
    return {
      items: await this.withDrivers(rows),
      page: query.page,
      limit: query.limit,
      total,
      hasMore: query.page * query.limit < total,
    };
  }

  async getForAdmin(requestId: string): Promise<AdminDriverChangeView> {
    const request = await this.requests.findById(requestId).exec();
    if (!request) throw this.notFound();
    const [view] = await this.withDrivers([request]);
    return view;
  }

  async fileForAdmin(requestId: string): Promise<string> {
    return this.fileOf({ _id: requestId });
  }

  async countPending(): Promise<number> {
    return this.requests.countDocuments({ status: DriverChangeStatus.PENDING }).exec();
  }

  /**
   * Applies the change. The request is claimed first (PENDING → APPROVED),
   * so two admins approving at once apply it once; if applying fails (e.g.
   * the plate was taken meanwhile) the claim is released.
   */
  async approve(requestId: string, adminId: string): Promise<AdminDriverChangeView> {
    const reviewedAt = new Date();
    const claimed = await this.requests
      .findOneAndUpdate(
        { _id: requestId, status: DriverChangeStatus.PENDING },
        { $set: { status: DriverChangeStatus.APPROVED, reviewedBy: new Types.ObjectId(adminId), reviewedAt } },
        { returnDocument: "after" },
      )
      .select("+filePath")
      .exec();
    if (!claimed) throw await this.notPendingOrMissing(requestId);

    try {
      await this.apply(claimed, adminId, reviewedAt);
    } catch (error) {
      await this.requests
        .updateOne(
          { _id: claimed._id, status: DriverChangeStatus.APPROVED },
          { $set: { status: DriverChangeStatus.PENDING }, $unset: { reviewedBy: 1, reviewedAt: 1 } },
        )
        .exec();
      throw error;
    }

    this.logger.log(`Driver change ${claimed._id.toHexString()} (${claimed.kind}) approved by ${adminId}`);
    this.emitReviewed(claimed, true);
    return this.getForAdmin(requestId);
  }

  async reject(requestId: string, adminId: string, reason: string): Promise<AdminDriverChangeView> {
    const request = await this.requests
      .findOneAndUpdate(
        { _id: requestId, status: DriverChangeStatus.PENDING },
        {
          $set: {
            status: DriverChangeStatus.REJECTED,
            reviewNote: reason,
            reviewedBy: new Types.ObjectId(adminId),
            reviewedAt: new Date(),
          },
          $unset: { filePath: 1 },
        },
        { returnDocument: "before" },
      )
      .select("+filePath")
      .exec();
    if (!request) throw await this.notPendingOrMissing(requestId);
    // A rejected upload is not kept: nothing uses it, and it is personal data.
    if (request.filePath) await removeFile(request.filePath);
    request.status = DriverChangeStatus.REJECTED;
    request.reviewNote = reason;
    this.emitReviewed(request, false, reason);
    return this.getForAdmin(requestId);
  }

  // ── internals ──────────────────────────────────────────────────────────

  private async apply(request: DriverChangeRequestDocument, adminId: string, at: Date): Promise<void> {
    switch (request.kind) {
      case DriverChangeKind.DRIVER_PROFILE: {
        const set: Record<string, unknown> = {};
        for (const [field, value] of Object.entries(request.changes))
          set[field] = PROFILE_DATE_FIELDS.has(field) ? new Date(value as string | Date) : value;
        const result = await this.drivers.updateOne({ _id: request.driverId }, { $set: set }).exec();
        if (result.matchedCount === 0) throw apiNotFound("Driver profile not found", "DRIVER_NOT_FOUND");
        return;
      }
      case DriverChangeKind.VEHICLE: {
        const vehicle = await this.vehicles.findOne({ _id: request.vehicleId, driverId: request.driverId }).exec();
        if (!vehicle) throw apiNotFound("The vehicle no longer exists", "VEHICLE_NOT_FOUND");
        const set: Record<string, unknown> = {};
        for (const [apiField, value] of Object.entries(request.changes)) {
          const schemaField = VEHICLE_FIELDS[apiField as keyof typeof VEHICLE_FIELDS];
          if (schemaField) set[schemaField] = value;
        }
        if (typeof set.registrationNumber === "string") await this.assertPlateFree(set.registrationNumber, vehicle._id);
        try {
          await this.vehicles.updateOne({ _id: vehicle._id }, { $set: set }).exec();
        } catch (error) {
          if (isDuplicateKey(error)) throw this.plateTaken();
          throw error;
        }
        return;
      }
      case DriverChangeKind.DRIVER_DOCUMENT:
      case DriverChangeKind.VEHICLE_DOCUMENT: {
        if (!request.filePath) throw apiConflict("The uploaded file is missing", "DOCUMENT_NOT_FOUND");
        const isVehicle = request.kind === DriverChangeKind.VEHICLE_DOCUMENT;
        const verified = {
          filePath: request.filePath,
          status: DocumentStatus.VERIFIED,
          verifiedBy: new Types.ObjectId(adminId),
          verifiedAt: at,
          documentNumber: request.changes.documentNumber as string | undefined,
          expiryDate: request.changes.expiryDate ? new Date(request.changes.expiryDate as string | Date) : undefined,
        };
        // Driver and vehicle documents share every field this touches.
        const model = (isVehicle ? this.vehicleDocuments : this.driverDocuments) as unknown as Model<DocumentRecord>;
        const owner = isVehicle ? { vehicleId: request.vehicleId } : { driverId: request.driverId };
        if (isVehicle && !(await this.vehicles.exists({ _id: request.vehicleId, driverId: request.driverId })))
          throw apiNotFound("The vehicle no longer exists", "VEHICLE_NOT_FOUND");
        const previous = await model.findOne({ ...owner, documentType: request.documentType }).exec();
        const fields = Object.fromEntries(Object.entries(verified).filter(([, value]) => value !== undefined));
        const unset = {
          ...(verified.documentNumber === undefined ? { documentNumber: 1 } : {}),
          ...(verified.expiryDate === undefined ? { expiryDate: 1 } : {}),
          ...(isVehicle ? {} : { rejectionReason: 1 }),
        };
        if (previous) {
          await model
            .updateOne({ _id: previous._id }, { $set: fields, ...(Object.keys(unset).length ? { $unset: unset } : {}) })
            .exec();
          if (previous.filePath !== request.filePath) await removeFile(previous.filePath);
        } else {
          await model.create({ ...owner, documentType: request.documentType, ...fields });
        }
        return;
      }
    }
  }

  private async upsertPending(
    driver: DriverProfileDocument,
    request: {
      kind: DriverChangeKind;
      targetKey: string;
      vehicleId?: Types.ObjectId;
      documentType?: string;
      changes: Record<string, unknown>;
      previous: Record<string, unknown>;
      filePath?: string;
    },
  ): Promise<DriverChangeView> {
    const isDocument =
      request.kind === DriverChangeKind.DRIVER_DOCUMENT || request.kind === DriverChangeKind.VEHICLE_DOCUMENT;
    if (!isDocument && Object.keys(request.changes).length === 0)
      throw apiBadRequest("Nothing to change: these are already your verified details", "DRIVER_CHANGE_EMPTY");

    const filter = { driverId: driver._id, targetKey: request.targetKey, status: DriverChangeStatus.PENDING };
    const fields = {
      userId: driver.userId,
      kind: request.kind,
      changes: request.changes,
      previous: request.previous,
      ...(request.vehicleId ? { vehicleId: request.vehicleId } : {}),
      ...(request.documentType ? { documentType: request.documentType } : {}),
      ...(request.filePath ? { filePath: request.filePath } : {}),
    };
    const write = () =>
      this.requests
        .findOneAndUpdate(
          filter,
          // A resubmission is a new request: it goes to the back of the queue.
          { $set: { ...fields, createdAt: new Date(), updatedAt: new Date() } },
          { upsert: true, returnDocument: "before", timestamps: false },
        )
        .select("+filePath")
        .exec();
    let replaced: DriverChangeRequestDocument | null;
    try {
      replaced = await write();
    } catch (error) {
      // Two first submissions for one target raced on the unique index.
      if (!isDuplicateKey(error)) throw error;
      replaced = await write();
    }
    if (replaced?.filePath && replaced.filePath !== request.filePath) await removeFile(replaced.filePath);

    const saved = await this.requests.findOne(filter).exec();
    return this.toView(saved!);
  }

  private diff(
    requested: Record<string, unknown>,
    current: Record<string, unknown>,
  ): { changes: Record<string, unknown>; previous: Record<string, unknown> } {
    const changes: Record<string, unknown> = {};
    const previous: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(requested)) {
      if (sameValue(value, current[field])) continue;
      changes[field] = value;
      previous[field] = current[field] ?? null;
    }
    return { changes, previous };
  }

  private async driverFor(userId: string): Promise<DriverProfileDocument> {
    const driver = await this.drivers.findOne({ userId: new Types.ObjectId(userId) }).exec();
    if (!driver) throw apiNotFound("Driver profile not found", "DRIVER_NOT_FOUND");
    return driver;
  }

  /** Before approval, drivers edit their details directly (onboarding); after it, they ask. */
  private async requesterFor(userId: string): Promise<DriverProfileDocument> {
    const driver = await this.driverFor(userId);
    if (!CAN_REQUEST.includes(driver.driverStatus))
      throw apiBadRequest(
        "Your application is not approved yet: edit your details directly in onboarding",
        "INVALID_DRIVER_STATUS",
      );
    return driver;
  }

  private async activeVehicle(driver: DriverProfileDocument, vehicleId: string): Promise<VehicleDoc> {
    const vehicle = Types.ObjectId.isValid(vehicleId)
      ? await this.vehicles.findOne({ _id: vehicleId, driverId: driver._id, isActive: true }).exec()
      : null;
    if (!vehicle) throw apiNotFound("Vehicle not found", "VEHICLE_NOT_FOUND");
    return vehicle;
  }

  private async assertPlateFree(registrationNumber: string, vehicleId: Types.ObjectId): Promise<void> {
    if (await this.vehicles.exists({ registrationNumber, _id: { $ne: vehicleId } })) throw this.plateTaken();
  }

  private plateTaken() {
    return apiConflict("A vehicle with this registration number already exists", "VEHICLE_ALREADY_EXISTS");
  }

  private async fileOf(filter: Record<string, unknown>): Promise<string> {
    const id = filter._id as string;
    if (!Types.ObjectId.isValid(id)) throw this.notFound();
    const request = await this.requests.findOne(filter).select("+filePath").exec();
    if (!request) throw this.notFound();
    if (!request.filePath) throw apiNotFound("This change has no file", "DOCUMENT_NOT_FOUND");
    return request.filePath;
  }

  private async notPendingOrMissing(requestId: string) {
    const exists = Types.ObjectId.isValid(requestId) && (await this.requests.exists({ _id: requestId }));
    return exists ? apiConflict("This change has already been reviewed", "DRIVER_CHANGE_NOT_PENDING") : this.notFound();
  }

  private notFound() {
    return apiNotFound("Change request not found", "DRIVER_CHANGE_NOT_FOUND");
  }

  private emitReviewed(request: DriverChangeRequestDocument, approved: boolean, reason?: string): void {
    this.domainEvents.emit("driver.change_reviewed", {
      requestId: request._id.toHexString(),
      driverId: request.driverId.toHexString(),
      userId: request.userId.toHexString(),
      label: labelOf(request),
      approved,
      reason,
    });
  }

  private async withDrivers(rows: DriverChangeRequestDocument[]): Promise<AdminDriverChangeView[]> {
    const driverIds = [...new Set(rows.map((row) => row.driverId.toHexString()))].map((id) => new Types.ObjectId(id));
    const drivers = await this.drivers.find({ _id: { $in: driverIds } }).select("userId driverCode driverStatus").lean().exec();
    const users = await this.users
      .find({ _id: { $in: drivers.map((driver) => driver.userId) } })
      .select("firstName lastName phone")
      .lean()
      .exec();
    const userById = new Map(users.map((user) => [user._id.toHexString(), user]));
    const driverById = new Map(drivers.map((driver) => [driver._id.toHexString(), driver]));
    return rows.map((row) => {
      const driver = driverById.get(row.driverId.toHexString());
      const user = driver ? userById.get(driver.userId.toHexString()) : undefined;
      return {
        ...this.toView(row),
        driver: {
          id: row.driverId.toHexString(),
          driverCode: driver?.driverCode ?? "",
          driverStatus: driver?.driverStatus ?? DriverStatus.APPROVED,
          name: user ? [user.firstName, user.lastName].filter(Boolean).join(" ") : "Unknown driver",
          phone: user?.phone ?? "",
        },
      };
    });
  }

  private toView(row: DriverChangeRequestDocument): DriverChangeView {
    return {
      id: row._id.toHexString(),
      kind: row.kind,
      label: labelOf(row),
      status: row.status,
      vehicleId: row.vehicleId?.toHexString(),
      documentType: row.documentType,
      changes: row.changes ?? {},
      previous: row.previous ?? {},
      // Rejected and withdrawn uploads are deleted.
      hasFile:
        (row.kind === DriverChangeKind.DRIVER_DOCUMENT || row.kind === DriverChangeKind.VEHICLE_DOCUMENT) &&
        (row.status === DriverChangeStatus.PENDING || row.status === DriverChangeStatus.APPROVED),
      reviewNote: row.reviewNote,
      submittedAt: row.createdAt,
      reviewedAt: row.reviewedAt,
    };
  }
}

export function labelOf(request: Pick<DriverChangeRequest, "kind" | "documentType">): string {
  switch (request.kind) {
    case DriverChangeKind.DRIVER_PROFILE:
      return "Licence details";
    case DriverChangeKind.VEHICLE:
      return "Vehicle details";
    default:
      return DOCUMENT_LABELS[request.documentType ?? ""] ?? "Document";
  }
}
