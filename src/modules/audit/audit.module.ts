import { Global, Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { User, UserSchema } from "../users/schemas/user.schema";
import { AuditLogService } from "./audit-log.service";
import {
  AdminAuditLog,
  AdminAuditLogSchema,
} from "./schemas/admin-audit-log.schema";

/** Global so any module's admin action can be audited without new imports. */
@Global()
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: AdminAuditLog.name, schema: AdminAuditLogSchema },
      { name: User.name, schema: UserSchema },
    ]),
  ],
  providers: [AuditLogService],
  exports: [AuditLogService],
})
export class AuditModule {}
