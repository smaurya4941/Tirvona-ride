import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDate,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from "class-validator";
import { TripDto } from "../../rides/dto/ride-requests.dto";
import { RIDE_TYPE_CODE_PATTERN } from "../../ride-types/schemas/ride-type.schema";
import { PromoDiscountType, PromoStatus } from "../promo-rules";
import { PROMO_CODE_PATTERN } from "../schemas/promo-code.schema";

const MONEY = { allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 };
const upper = ({ value }: { value: unknown }) => (typeof value === "string" ? value.trim().toUpperCase() : value);

export class CreatePromoDto {
  @ApiProperty({ example: "BRAJ50" })
  @Transform(upper)
  @Matches(PROMO_CODE_PATTERN, { message: "code must be 3–20 letters or digits" })
  code!: string;

  @ApiProperty({ example: "₹50 off your first ride" })
  @IsString()
  @Length(3, 80)
  title!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 300)
  description?: string;

  @ApiProperty({ enum: PromoDiscountType })
  @IsEnum(PromoDiscountType)
  discountType!: PromoDiscountType;

  @ApiProperty({ example: 50, description: "Percent (1–100) or rupees" })
  @IsNumber(MONEY)
  @Min(1)
  @Max(5_000)
  discountValue!: number;

  @ApiPropertyOptional({ example: 100 })
  @IsOptional()
  @IsNumber(MONEY)
  @Min(1)
  @Max(5_000)
  maxDiscount?: number;

  @ApiPropertyOptional({ example: 80 })
  @IsOptional()
  @IsNumber(MONEY)
  @Min(0)
  @Max(20_000)
  minRideValue?: number;

  @ApiPropertyOptional({ example: 1000, description: "Total uses; omit for unlimited" })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10_000_000)
  usageLimit?: number;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1_000)
  perUserLimit?: number;

  @ApiProperty()
  @Type(() => Date)
  @IsDate()
  startsAt!: Date;

  @ApiProperty()
  @Type(() => Date)
  @IsDate()
  endsAt!: Date;

  @ApiPropertyOptional({ enum: PromoStatus, default: PromoStatus.ACTIVE })
  @IsOptional()
  @IsEnum(PromoStatus)
  status?: PromoStatus;

  @ApiPropertyOptional({ type: [String], description: "Ride type codes; empty = all" })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @Matches(RIDE_TYPE_CODE_PATTERN, { each: true })
  applicableRideTypes?: string[];

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  showInApp?: boolean;
}

/** Everything but the code (it may be printed on posters already). */
export class UpdatePromoDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(3, 80)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 300)
  description?: string;

  @ApiPropertyOptional({ enum: PromoDiscountType })
  @IsOptional()
  @IsEnum(PromoDiscountType)
  discountType?: PromoDiscountType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber(MONEY)
  @Min(1)
  @Max(5_000)
  discountValue?: number;

  @ApiPropertyOptional({ nullable: true, description: "null removes the cap" })
  @IsOptional()
  @IsNumber(MONEY)
  @Min(1)
  @Max(5_000)
  maxDiscount?: number | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsNumber(MONEY)
  @Min(0)
  @Max(20_000)
  minRideValue?: number | null;

  @ApiPropertyOptional({ nullable: true, description: "null = unlimited" })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10_000_000)
  usageLimit?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1_000)
  perUserLimit?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  startsAt?: Date;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  endsAt?: Date;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @Matches(RIDE_TYPE_CODE_PATTERN, { each: true })
  applicableRideTypes?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  showInApp?: boolean;
}

export class PromoStatusDto {
  @ApiProperty({ enum: PromoStatus })
  @IsEnum(PromoStatus)
  status!: PromoStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(3, 240)
  reason?: string;
}

export class ListPromosQueryDto {
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

  @ApiPropertyOptional({ enum: PromoStatus })
  @IsOptional()
  @IsEnum(PromoStatus)
  status?: PromoStatus;

  @ApiPropertyOptional({ enum: ["LIVE", "SCHEDULED", "EXPIRED"], description: "Validity window relative to now" })
  @IsOptional()
  @IsEnum(["LIVE", "SCHEDULED", "EXPIRED"])
  window?: "LIVE" | "SCHEDULED" | "EXPIRED";

  @ApiPropertyOptional({ description: "Code or title contains" })
  @IsOptional()
  @IsString()
  @Length(1, 40)
  search?: string;
}

/** Customer: "would this code work for this trip?" — priced by the server. */
export class ValidatePromoDto extends TripDto {
  @ApiProperty({ example: "BRAJ50" })
  @Transform(upper)
  @IsString()
  @Length(3, 20)
  code!: string;

  @ApiProperty({ example: "AUTO" })
  @Matches(RIDE_TYPE_CODE_PATTERN)
  rideType!: string;
}

/** Trip-free check of a code (Offers screen, before a trip is chosen). */
export class CheckPromoDto {
  @ApiProperty({ example: "BRAJ50" })
  @Transform(upper)
  @IsString()
  @Length(3, 20)
  code!: string;
}
