import { Injectable, Logger } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import type { Model, QueryFilter } from "mongoose";
import { Types } from "mongoose";
import type { Page } from "../rides/rides.service";
import { User } from "../users/schemas/user.schema";
import { AdminAuditLog } from "./schemas/admin-audit-log.schema";

export interface AuditEntry {
  adminId: string;
  action: string;
  targetType: string;
  targetId: string;
  targetLabel?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export interface AuditLogView {
  id: string;
  adminId: string;
  adminName?: string;
  action: string;
  targetType: string;
  targetId: string;
  targetLabel?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

export interface AuditLogQuery {
  page: number;
  limit: number;
  targetType?: string;
  targetId?: string;
  action?: string;
}

const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name);

  constructor(
    @InjectModel(AdminAuditLog.name)
    private readonly auditModel: Model<AdminAuditLog>,
    @InjectModel(User.name) private readonly userModel: Model<User>,
  ) {}

  /**
   * Called after the action committed. A failed audit write is logged loudly
   * but never turns a completed admin action into an error.
   */
  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.auditModel.create({
        ...entry,
        adminId: new Types.ObjectId(entry.adminId),
      });
    } catch (error) {
      this.logger.error(
        `Failed to audit ${entry.action} on ${entry.targetType}:${entry.targetId} by ${entry.adminId}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  async list(query: AuditLogQuery): Promise<Page<AuditLogView>> {
    const filter: QueryFilter<AdminAuditLog> = {};
    if (query.targetType) filter.targetType = query.targetType;
    if (query.targetId) filter.targetId = query.targetId;
    if (query.action)
      filter.action = { $regex: `^${escapeRegex(query.action)}` };

    const [rows, total] = await Promise.all([
      this.auditModel
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .lean()
        .exec(),
      this.auditModel.countDocuments(filter).exec(),
    ]);
    const admins = await this.userModel
      .find({
        _id: {
          $in: [...new Set(rows.map((row) => row.adminId.toString()))].map(
            (id) => new Types.ObjectId(id),
          ),
        },
      })
      .select("firstName lastName")
      .lean()
      .exec();
    const nameOf = new Map(
      admins.map((admin) => [
        admin._id.toString(),
        [admin.firstName, admin.lastName].filter(Boolean).join(" "),
      ]),
    );

    return {
      items: rows.map((row) => ({
        id: row._id.toString(),
        adminId: row.adminId.toString(),
        adminName: nameOf.get(row.adminId.toString()),
        action: row.action,
        targetType: row.targetType,
        targetId: row.targetId,
        targetLabel: row.targetLabel,
        reason: row.reason,
        metadata: row.metadata,
        createdAt: row.createdAt!,
      })),
      page: query.page,
      limit: query.limit,
      total,
      hasMore: query.page * query.limit < total,
    };
  }
}
