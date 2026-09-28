import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDate,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from "class-validator";
import { RideActorType } from "../../rides/ride-state-machine";
import type { RideStatus } from "../../rides/ride-state-machine";
import { FEE_ELIGIBLE_STATUSES } from "../cancellation-fee";
import { CancellationFeeStatus } from "../schemas/cancellation.schemas";

const MONEY = { allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 };
const REASON_CODE = /^[A-Z][A-Z0-9_]{1,39}$/;
const PICKABLE_ACTORS = [RideActorType.CUSTOMER, RideActorType.DRIVER, RideActorType.ADMIN] as const;

export class CreateCancellationReasonDto {
  @ApiProperty({ example: "LONG_WAIT_AT_PICKUP" })
  @Matches(REASON_CODE, { message: "code must be upper-case letters, digits or underscores" })
  code!: string;

  @ApiProperty({ enum: PICKABLE_ACTORS })
  @IsIn(PICKABLE_ACTORS)
  actor!: RideActorType;

  @ApiProperty()
  @IsString()
  @Length(2, 80)
  label!: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  requiresNote?: boolean;

  @ApiPropertyOptional({ default: 50 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  sortOrder?: number;
}

export class UpdateCancellationReasonDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(2, 80)
  label?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  requiresNote?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  sortOrder?: number;
}

export class CustomerFeePolicyDto {
  @ApiProperty()
  @IsBoolean()
  enabled!: boolean;

  @ApiProperty({ example: 120, description: "Free window after the driver accepts, seconds" })
  @IsInt()
  @Min(0)
  @Max(3_600)
  graceSeconds!: number;

  @ApiProperty({ example: 0 })
  @IsNumber(MONEY)
  @Min(0)
  @Max(1_000)
  fixedFee!: number;

  @ApiProperty({ example: 0 })
  @IsNumber(MONEY)
  @Min(0)
  @Max(100)
  percentOfFare!: number;

  @ApiProperty({ example: 0, description: "0 = no cap beyond the fare" })
  @IsNumber(MONEY)
  @Min(0)
  @Max(5_000)
  maxFee!: number;

  @ApiProperty({ enum: FEE_ELIGIBLE_STATUSES, isArray: true })
  @IsArray()
  @ArrayMaxSize(FEE_ELIGIBLE_STATUSES.length)
  @IsIn(FEE_ELIGIBLE_STATUSES, { each: true })
  applicableStatuses!: RideStatus[];
}

export class UpdateCancellationPolicyDto {
  @ApiProperty({ type: CustomerFeePolicyDto })
  @ValidateNested()
  @Type(() => CustomerFeePolicyDto)
  customerFee!: CustomerFeePolicyDto;

  @ApiProperty({ description: "Why the policy changed (audit)" })
  @IsString()
  @Length(3, 240)
  note!: string;
}

export class ResolveCancellationFeeDto {
  @ApiProperty({ enum: [CancellationFeeStatus.WAIVED, CancellationFeeStatus.COLLECTED] })
  @IsIn([CancellationFeeStatus.WAIVED, CancellationFeeStatus.COLLECTED])
  status!: CancellationFeeStatus.WAIVED | CancellationFeeStatus.COLLECTED;

  @ApiProperty({ example: "Driver confirmed customer was waiting at the wrong gate" })
  @IsString()
  @Length(3, 240)
  note!: string;
}

export class ListCancellationsQueryDto {
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

  @ApiPropertyOptional({ enum: RideActorType })
  @IsOptional()
  @IsEnum(RideActorType)
  cancelledBy?: RideActorType;

  @ApiPropertyOptional({ enum: CancellationFeeStatus })
  @IsOptional()
  @IsEnum(CancellationFeeStatus)
  feeStatus?: CancellationFeeStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(REASON_CODE)
  reasonCode?: string;

  @ApiPropertyOptional({ description: "Ride code prefix" })
  @IsOptional()
  @IsString()
  @Length(1, 20)
  search?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  from?: Date;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  to?: Date;
}
