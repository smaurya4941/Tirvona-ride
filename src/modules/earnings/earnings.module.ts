import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { DriversModule } from "../drivers/drivers.module";
import { UsersModule } from "../users/users.module";
import { CommissionService } from "./commission.service";
import { EarningsAdminService } from "./earnings-admin.service";
import { EarningsController } from "./earnings.controller";
import { EarningsService } from "./earnings.service";
import { CommissionConfig, CommissionConfigSchema } from "./schemas/commission-config.schema";
import { DriverEarning, DriverEarningSchema } from "./schemas/driver-earning.schema";
import { DriverPayout, DriverPayoutSchema } from "./schemas/driver-payout.schema";

// Leaf of the money domain: depends only on drivers/users. Payments writes
// into it; Rides (dashboard) and Admin read from it.
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: DriverEarning.name, schema: DriverEarningSchema },
      { name: CommissionConfig.name, schema: CommissionConfigSchema },
      { name: DriverPayout.name, schema: DriverPayoutSchema },
    ]),
    DriversModule,
    UsersModule,
  ],
  controllers: [EarningsController],
  providers: [EarningsService, EarningsAdminService, CommissionService],
  exports: [EarningsService, EarningsAdminService, CommissionService],
})
export class EarningsModule {}
