import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, Length, Max, Min } from "class-validator";
import { DriverStatus } from "../../drivers/schemas/driver-profile.schema";
import { UserStatus } from "../../users/schemas/user.schema";
import { VehicleType } from "../../vehicles/schemas/vehicle.schema";

const toBoolean = ({ value }: { value: unknown }) => (value === "true" ? true : value === "false" ? false : value);

class PageQueryDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10_000)
  page = 1;

  @ApiPropertyOptional({ default: 25 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 25;
}

export class AdminDriversQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: DriverStatus })
  @IsOptional()
  @IsEnum(DriverStatus)
  status?: DriverStatus;

  @ApiPropertyOptional({ description: "Driver code, name or phone" })
  @IsOptional()
  @IsString()
  @Length(1, 40)
  search?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  online?: boolean;
}

export class AdminCustomersQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: UserStatus })
  @IsOptional()
  @IsEnum(UserStatus)
  status?: UserStatus;

  @ApiPropertyOptional({ description: "Name, phone or email" })
  @IsOptional()
  @IsString()
  @Length(1, 60)
  search?: string;
}

export class AdminVehiclesQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: VehicleType })
  @IsOptional()
  @IsEnum(VehicleType)
  vehicleType?: VehicleType;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  active?: boolean;

  @ApiPropertyOptional({ description: "Registration number contains" })
  @IsOptional()
  @IsString()
  @Length(1, 20)
  search?: string;
}

export class AdminReasonDto {
  @ApiProperty({ example: "Repeated no-shows reported by customers" })
  @IsString()
  @Length(3, 300)
  reason!: string;
}

export class AdminOptionalReasonDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(3, 300)
  reason?: string;
}

export class AuditLogQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ example: "DRIVER" })
  @IsOptional()
  @IsString()
  @Length(2, 30)
  targetType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 40)
  targetId?: string;

  @ApiPropertyOptional({ example: "driver.", description: "Action prefix" })
  @IsOptional()
  @IsString()
  @Length(2, 40)
  action?: string;
}
