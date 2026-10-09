import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from "class-validator";
import { RIDE_TYPE_CODE_PATTERN } from "../../ride-types/schemas/ride-type.schema";
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

  @ApiPropertyOptional({ example: "AUTO" })
  @IsOptional()
  @Matches(RIDE_TYPE_CODE_PATTERN)
  rideType?: string;

  @ApiPropertyOptional({
    description: "Ride code prefix, ride id, or customer phone",
  })
  @IsOptional()
  @IsString()
  @Length(1, 40)
  search?: string;

  /**
   * `true`: trips that ended without the rider's code (driver override, admin,
   * SOS) or far from the booked drop-off — what support should look at.
   */
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => value === true || value === "true" || value === "1")
  needsReview?: boolean;
}

export class AdminCompleteRideDto {
  @ApiProperty({ example: "Rider unreachable; driver confirmed drop-off" })
  @IsString()
  @Length(3, 240)
  note!: string;
}

export class AdminCancelRideDto {
  @ApiPropertyOptional({
    example: "CUSTOMER_REQUEST",
    description: "ADMIN cancellation reason code (defaults to OTHER)",
  })
  @IsOptional()
  @Matches(/^[A-Z][A-Z0-9_]{1,39}$/)
  reasonCode?: string;

  @ApiProperty({ example: "Customer called support to cancel" })
  @IsString()
  @Length(3, 240)
  reason!: string;
}
