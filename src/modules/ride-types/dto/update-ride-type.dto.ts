import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsBoolean,
  IsEnum,
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
import { VehicleType } from "../../vehicles/schemas/vehicle.schema";
import { InitialDistanceDto } from "../../ride-config/dto/ride-config.dto";
import { RIDE_TYPE_CODE_PATTERN } from "../schemas/ride-type.schema";

/** Icon keys the mobile apps bundle; anything else would render a blank. */
export const RIDE_TYPE_ICONS = [
  "bike",
  "auto",
  "e_rickshaw",
  "cab",
  "cab_xl",
  "premium",
] as const;

const MONEY = { allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 };

export class UpdateRideTypeDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(2, 40)
  displayName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 160)
  description?: string;

  @ApiPropertyOptional({ enum: RIDE_TYPE_ICONS })
  @IsOptional()
  @IsString()
  @Matches(new RegExp(`^(${RIDE_TYPE_ICONS.join("|")})$`), {
    message: `icon must be one of ${RIDE_TYPE_ICONS.join(", ")}`,
  })
  icon?: string;

  @ApiPropertyOptional({
    enum: VehicleType,
    description: "Which drivers serve it (applies to new bookings)",
  })
  @IsOptional()
  @IsEnum(VehicleType)
  vehicleType?: VehicleType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(8)
  seatCapacity?: number;

  @ApiPropertyOptional({
    description: "Customers can book it (requires a tariff)",
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  sortOrder?: number;

  @ApiPropertyOptional({
    description:
      "Audit note, required by the panel when switching a ride type off",
  })
  @IsOptional()
  @IsString()
  @Length(3, 240)
  reason?: string;
}

export class InitialTariffDto {
  @ApiProperty({ example: 30 })
  @IsNumber(MONEY)
  @Min(0)
  @Max(5_000)
  baseFare!: number;

  @ApiProperty({ example: 10 })
  @IsNumber(MONEY)
  @Min(0)
  @Max(500)
  perKmRate!: number;

  @ApiProperty({ example: 1.5 })
  @IsNumber(MONEY)
  @Min(0)
  @Max(100)
  perMinuteRate!: number;

  @ApiProperty({ example: 40 })
  @IsNumber(MONEY)
  @Min(0)
  @Max(10_000)
  minimumFare!: number;
}

export class CreateRideTypeDto {
  @ApiProperty({ example: "CAB_XL" })
  @Matches(RIDE_TYPE_CODE_PATTERN, {
    message: "code must be 2–24 upper-case letters, digits or underscores",
  })
  code!: string;

  @ApiProperty({ example: "Cab XL" })
  @IsString()
  @Length(2, 40)
  displayName!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 160)
  description?: string;

  @ApiProperty({ enum: RIDE_TYPE_ICONS })
  @Matches(new RegExp(`^(${RIDE_TYPE_ICONS.join("|")})$`), {
    message: `icon must be one of ${RIDE_TYPE_ICONS.join(", ")}`,
  })
  icon!: string;

  @ApiProperty({ enum: VehicleType })
  @IsEnum(VehicleType)
  vehicleType!: VehicleType;

  @ApiProperty({ example: 4 })
  @IsInt()
  @Min(1)
  @Max(8)
  seatCapacity!: number;

  @ApiPropertyOptional({ default: 50 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  sortOrder?: number;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({
    type: InitialTariffDto,
    description: "Required to create it active",
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => InitialTariffDto)
  pricing?: InitialTariffDto;

  @ApiPropertyOptional({
    type: InitialDistanceDto,
    description:
      "Minimum (m) and maximum (km) trip distance. Required to create it active",
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => InitialDistanceDto)
  distance?: InitialDistanceDto;
}
