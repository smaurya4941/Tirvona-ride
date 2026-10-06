import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import {
  IsEnum,
  IsISO8601,
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from "class-validator";
import { LocationPointDto } from "../../locations/dto/location-point.dto";
import { RIDE_TYPE_CODE_PATTERN } from "../../ride-types/schemas/ride-type.schema";
import { RideStatus } from "../ride-state-machine";

export class TripDto {
  @ApiProperty({ type: LocationPointDto })
  @ValidateNested()
  @Type(() => LocationPointDto)
  pickup!: LocationPointDto;

  @ApiProperty({ type: LocationPointDto })
  @ValidateNested()
  @Type(() => LocationPointDto)
  destination!: LocationPointDto;
}

/**
 * Body of both POST /rides/estimate and POST /rides. There is deliberately
 * no fare field: the server always re-prices, whatever the client displayed.
 */
export class RideRequestDto extends TripDto {
  @ApiProperty({
    example: "AUTO",
    description: "Ride type code (GET /ride-types)",
  })
  @Matches(RIDE_TYPE_CODE_PATTERN, {
    message: "rideType must be a ride type code such as AUTO",
  })
  rideType!: string;
}

/** POST /rides — a booking may carry a promo code; the server validates and reserves it. */
export class CreateRideDto extends RideRequestDto {
  @ApiPropertyOptional({ example: "BRAJ50" })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? value.trim().toUpperCase() : value,
  )
  @IsString()
  @Length(3, 20)
  promoCode?: string;
}

export class CancelRideDto {
  @ApiPropertyOptional({
    example: "DRIVER_TOO_LONG",
    description: "Code from GET /rides/:id/cancellation",
  })
  @IsOptional()
  @Matches(/^[A-Z][A-Z0-9_]{1,39}$/)
  reasonCode?: string;

  @ApiPropertyOptional({
    example: "Plans changed",
    description:
      "Note (required for reasons such as OTHER); legacy free-text reason",
  })
  @IsOptional()
  @IsString()
  @Length(1, 240)
  reason?: string;
}

export class RejectRideDto {
  @ApiPropertyOptional({ example: "Too far" })
  @IsOptional()
  @IsString()
  @Length(1, 240)
  reason?: string;
}

export class StartRideDto {
  @ApiProperty({ example: "4821" })
  @Matches(/^\d{4}$/, {
    message: "otp must be the 4-digit code shown to the customer",
  })
  otp!: string;
}

export class ListRidesQueryDto {
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
  @Max(50)
  limit = 20;

  @ApiPropertyOptional({ enum: RideStatus })
  @IsOptional()
  @IsEnum(RideStatus)
  status?: RideStatus;

  /**
   * Instants with an offset (the app sends UTC), so "today" means the rider's
   * day, not the server's. Matched against requestedAt: start inclusive,
   * end exclusive.
   */
  @ApiPropertyOptional({
    example: "2026-09-23T18:30:00.000Z",
    description: "Rides requested at or after this instant",
  })
  @IsOptional()
  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(/(Z|[+-]\d{2}:?\d{2})$/, {
    message: "startDate must include a time zone offset (e.g. Z)",
  })
  startDate?: string;

  @ApiPropertyOptional({
    example: "2026-09-30T18:30:00.000Z",
    description: "Rides requested before this instant",
  })
  @IsOptional()
  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(/(Z|[+-]\d{2}:?\d{2})$/, {
    message: "endDate must include a time zone offset (e.g. Z)",
  })
  endDate?: string;
}

/** The rider's position, for the cars drawn on the Home map. */
export class NearbyDriversQueryDto {
  @ApiProperty({ example: 28.627 })
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @IsLatitude()
  latitude!: number;

  @ApiProperty({ example: 77.3727 })
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @IsLongitude()
  longitude!: number;
}

export class RecentDestinationsQueryDto {
  @ApiPropertyOptional({ default: 8, minimum: 1, maximum: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  limit = 8;
}
