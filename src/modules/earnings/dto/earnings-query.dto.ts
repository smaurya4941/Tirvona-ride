import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsEnum,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from "class-validator";
import { EarningStatus, EarningsPeriod } from "../interfaces/earning-status";

class PageQueryDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10_000)
  page = 1;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;
}

export class DriverEarningsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: EarningsPeriod, default: EarningsPeriod.ALL })
  @IsOptional()
  @IsEnum(EarningsPeriod)
  period: EarningsPeriod = EarningsPeriod.ALL;

  @ApiPropertyOptional({ enum: EarningStatus })
  @IsOptional()
  @IsEnum(EarningStatus)
  status?: EarningStatus;
}

export class AdminEarningsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: "Driver code, name or phone" })
  @IsOptional()
  @IsString()
  @Length(1, 60)
  search?: string;
}

export class AdminDriverLedgerQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: EarningStatus })
  @IsOptional()
  @IsEnum(EarningStatus)
  status?: EarningStatus;
}

// Bank / UPI reference as written on the transfer: letters, digits and a
// few separators only, so it can be searched and exported safely.
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9 ._/#-]*$/;

export class MarkEarningPaidDto {
  @ApiProperty({ example: "BANK-SEP-24001" })
  @IsString()
  @Length(3, 80)
  @Matches(REFERENCE, { message: "payoutReference may contain letters, digits, spaces and . _ / # -" })
  payoutReference!: string;

  @ApiPropertyOptional({ example: "September weekly settlement" })
  @IsOptional()
  @IsString()
  @Length(1, 240)
  note?: string;
}

export class CreatePayoutDto extends MarkEarningPaidDto {
  @ApiProperty({ description: "driver_profiles id" })
  @IsMongoId()
  driverId!: string;

  @ApiProperty({ type: [String], description: "AVAILABLE earnings of this driver being settled" })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(500)
  @ArrayUnique()
  @IsMongoId({ each: true })
  earningIds!: string[];
}
