import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsEnum, IsInt, IsOptional, IsString, Length, Max, Min } from "class-validator";
import { RideTypeCode } from "../../ride-types/schemas/ride-type.schema";
import { RideStatus } from "../../rides/ride-state-machine";

export class AdminListRidesQueryDto {
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

  @ApiPropertyOptional({ enum: RideStatus })
  @IsOptional()
  @IsEnum(RideStatus)
  status?: RideStatus;

  @ApiPropertyOptional({ enum: RideTypeCode })
  @IsOptional()
  @IsEnum(RideTypeCode)
  rideType?: RideTypeCode;

  @ApiPropertyOptional({ description: "Ride code prefix, ride id, or customer phone" })
  @IsOptional()
  @IsString()
  @Length(1, 40)
  search?: string;
}

export class AdminCancelRideDto {
  @ApiProperty({ example: "Customer called support to cancel" })
  @IsString()
  @Length(3, 240)
  reason!: string;
}
