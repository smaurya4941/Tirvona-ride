import { ApiProperty, ApiPropertyOptional, PartialType } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsEnum,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from "class-validator";
import { RIDE_TYPE_CODE_PATTERN } from "../../ride-types/schemas/ride-type.schema";
import { TIME_OF_DAY_PATTERN } from "../../pricing/peak-pricing";
import { CircuitPackageStatus, MAX_PASSENGERS, MAX_STOPS } from "../circuit-package.types";

const trim = ({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value);
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A stop is chosen from the Places search. The server resolves `placeId` itself
 * (name, address, coordinates), so a client can never invent a location.
 */
export class CircuitStopInputDto {
  @ApiProperty({ example: "google:ChIJ…", description: "Provider place id from GET /admin/circuit-packages/places/autocomplete" })
  @Transform(trim)
  @IsString()
  @Length(3, 300)
  placeId!: string;

  @ApiPropertyOptional({ example: "Prem Mandir", description: "Optional display name; defaults to the place's own name" })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 120)
  name?: string;
}

export class CircuitPricingDto {
  @ApiProperty({ example: 600, description: "Package price, rupees" })
  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1_000_000)
  basePrice!: number;

  @ApiProperty({ example: 30, description: "Included distance, km" })
  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 1 })
  @Min(0)
  @Max(2000)
  includedDistanceKm!: number;

  @ApiProperty({ example: 5, description: "Included duration, hours" })
  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 })
  @Min(0)
  @Max(72)
  includedDurationHours!: number;

  @ApiProperty({ example: 15, description: "Rupees per extra km" })
  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 })
  @Min(0)
  @Max(10_000)
  extraDistanceRatePerKm!: number;

  @ApiProperty({ example: 50, description: "Rupees per extra hour" })
  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100_000)
  extraDurationRatePerHour!: number;
}

export class CircuitAvailabilityDto {
  @ApiPropertyOptional({ example: [0, 1, 2, 3, 4, 5, 6], description: "0 = Monday … 6 = Sunday" })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  days?: number[];

  @ApiPropertyOptional({ example: "06:00" })
  @IsOptional()
  @Matches(TIME_OF_DAY_PATTERN, { message: "opensAt must be a 24-hour time such as 06:00" })
  opensAt?: string;

  @ApiPropertyOptional({ example: "20:00" })
  @IsOptional()
  @Matches(TIME_OF_DAY_PATTERN, { message: "closesAt must be a 24-hour time such as 20:00" })
  closesAt?: string;

  @ApiPropertyOptional({ example: "2026-08-20", description: "Season start (inclusive); null clears it" })
  @IsOptional()
  @Matches(DATE_PATTERN, { message: "validFrom must be YYYY-MM-DD" })
  validFrom?: string | null;

  @ApiPropertyOptional({ example: "2026-09-10", description: "Season end (inclusive); null clears it" })
  @IsOptional()
  @Matches(DATE_PATTERN, { message: "validUntil must be YYYY-MM-DD" })
  validUntil?: string | null;
}

export class ReferenceOriginDto {
  @ApiProperty({ example: "Vrindavan Bus Stand" })
  @Transform(trim)
  @IsString()
  @Length(2, 120)
  label!: string;

  @ApiProperty()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @IsLatitude()
  latitude!: number;

  @ApiProperty()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @IsLongitude()
  longitude!: number;
}

export class CreateCircuitPackageDto {
  @ApiProperty({ example: "Vrindavan Spiritual Circuit" })
  @Transform(trim)
  @IsString()
  @Length(3, 100)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(0, 1000)
  description?: string;

  @ApiProperty({ example: "Vrindavan" })
  @Transform(trim)
  @IsString()
  @Length(2, 60)
  city!: string;

  @ApiPropertyOptional({ type: [CircuitStopInputDto], description: "In visiting order. Replaces all stops when sent." })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_STOPS)
  @ValidateNested({ each: true })
  @Type(() => CircuitStopInputDto)
  stops?: CircuitStopInputDto[];

  @ApiPropertyOptional({ type: CircuitPricingDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => CircuitPricingDto)
  pricing?: CircuitPricingDto;

  @ApiPropertyOptional({ example: ["AUTO", "CAB"], description: "Ride type codes that can be booked with this circuit" })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ArrayUnique()
  @Matches(RIDE_TYPE_CODE_PATTERN, { each: true, message: "each ride type must be a ride type code such as AUTO" })
  rideTypes?: string[];

  @ApiPropertyOptional({ example: 4 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_PASSENGERS)
  maxPassengers?: number;

  @ApiPropertyOptional({ type: CircuitAvailabilityDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => CircuitAvailabilityDto)
  availability?: CircuitAvailabilityDto;

  @ApiPropertyOptional({ description: "Shown to customers before booking" })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(0, 1000)
  cancellationPolicy?: string;

  @ApiPropertyOptional({ type: ReferenceOriginDto, description: "Where Admin expects pickups, to judge viability. Not shown to customers." })
  @IsOptional()
  @ValidateNested()
  @Type(() => ReferenceOriginDto)
  referenceOrigin?: ReferenceOriginDto;
}

export class UpdateCircuitPackageDto extends PartialType(CreateCircuitPackageDto) {
  @ApiPropertyOptional({ example: "Festival pricing", description: "Recorded in the audit log" })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 240)
  reason?: string;
}

export class SetCircuitPackageStatusDto {
  @ApiProperty({ enum: CircuitPackageStatus })
  @IsEnum(CircuitPackageStatus)
  status!: CircuitPackageStatus;

  @ApiPropertyOptional({ example: "Temple closed for renovation" })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 240)
  reason?: string;
}

export class ListCircuitPackagesQueryDto {
  @ApiPropertyOptional({ enum: CircuitPackageStatus })
  @IsOptional()
  @IsEnum(CircuitPackageStatus)
  status?: CircuitPackageStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 60)
  city?: string;

  @ApiPropertyOptional({ description: "Matches name or code" })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 60)
  q?: string;
}

export class RoutePreviewDto {
  @ApiPropertyOptional({ type: [CircuitStopInputDto], description: "Preview these stops instead of the saved ones" })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_STOPS)
  @ValidateNested({ each: true })
  @Type(() => CircuitStopInputDto)
  stops?: CircuitStopInputDto[];

  @ApiPropertyOptional({ description: "Included distance to check against, km" })
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  includedDistanceKm?: number;
}

export class AdminPlaceSearchQueryDto {
  @ApiProperty({ example: "prem mandir" })
  @Transform(trim)
  @IsString()
  @Length(2, 100)
  q!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(0, 64)
  sessionToken?: string;
}

export class AdminPlaceResolveQueryDto {
  @ApiProperty({ example: "featured:prem-mandir" })
  @Transform(trim)
  @IsString()
  @Length(3, 300)
  id!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(0, 64)
  sessionToken?: string;
}
