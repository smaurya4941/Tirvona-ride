import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsISO8601,
  IsMongoId,
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
import { RideStatus } from "../../rides/ride-state-machine";
import { CircuitExceptionResolution } from "../circuit-ride.types";

const trim = ({ value }: { value: unknown }) =>
  typeof value === "string" ? value.trim() : value;
const toInt = ({ value }: { value: unknown }) =>
  typeof value === "string" && value.trim() !== "" ? Number(value) : value;

/**
 * Body of POST /circuit-rides/estimate and POST /circuit-rides. There is
 * deliberately no price, distance or stop in it: the package, its stops and
 * its tariff come from the server.
 */
export class CircuitEstimateDto {
  @ApiProperty({ description: "Circuit package id (GET /circuit-packages)" })
  @IsMongoId()
  packageId!: string;

  @ApiProperty({ example: "AUTO" })
  @Matches(RIDE_TYPE_CODE_PATTERN, {
    message: "rideType must be a ride type code such as AUTO",
  })
  rideType!: string;

  @ApiProperty({
    type: LocationPointDto,
    description:
      "Where the driver picks you up. It is the origin, never a stop.",
  })
  @ValidateNested()
  @Type(() => LocationPointDto)
  pickup!: LocationPointDto;

  @ApiProperty({ example: 3 })
  @IsInt()
  @Min(1)
  @Max(8)
  passengers!: number;
}

export class CreateCircuitRideDto extends CircuitEstimateDto {
  @ApiPropertyOptional({
    description:
      "Same value for every retry of one booking (also accepted as the Idempotency-Key header)",
  })
  @IsOptional()
  @IsString()
  @Length(8, 64)
  @Matches(/^[A-Za-z0-9_\-:.]+$/)
  idempotencyKey?: string;
}

export class StopNoteDto {
  @ApiPropertyOptional({ example: "Road closed for a procession" })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 240)
  note?: string;
}

export class ResolveCircuitExceptionDto {
  @ApiProperty({ enum: CircuitExceptionResolution })
  @IsEnum(CircuitExceptionResolution)
  resolution!: CircuitExceptionResolution;

  @ApiProperty({ example: "Spoke to the driver; skipping this stop" })
  @Transform(trim)
  @IsString()
  @Length(2, 240)
  note!: string;
}

export class EndCircuitDto {
  @ApiProperty({ example: "Customer asked to end the circuit early" })
  @Transform(trim)
  @IsString()
  @Length(2, 240)
  reason!: string;
}

export class StopOrderParamDto {
  @Transform(toInt)
  @IsInt()
  @Min(1)
  @Max(50)
  order!: number;
}

export class AdminListCircuitRidesQueryDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;

  @ApiPropertyOptional({ enum: RideStatus })
  @IsOptional()
  @IsEnum(RideStatus)
  status?: RideStatus;

  @ApiPropertyOptional({ description: "Circuit package id" })
  @IsOptional()
  @IsMongoId()
  packageId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 60)
  city?: string;

  @ApiPropertyOptional({ description: "Driver profile id" })
  @IsOptional()
  @IsMongoId()
  driverId?: string;

  @ApiPropertyOptional({ description: "PENDING | PAID | FAILED | …" })
  @IsOptional()
  @Matches(/^[A-Z_]{3,30}$/)
  paymentStatus?: string;

  @ApiPropertyOptional({
    description: "Booked at or after (ISO 8601, with offset)",
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  startDate?: string;

  @ApiPropertyOptional({ description: "Booked before (ISO 8601, with offset)" })
  @IsOptional()
  @IsISO8601({ strict: true })
  endDate?: string;

  @ApiPropertyOptional({ description: "Ride code (TR…)" })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 20)
  q?: string;
}

export class CircuitReportQueryDto {
  @ApiPropertyOptional({
    description: "Booked at or after (ISO 8601, with offset)",
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  startDate?: string;

  @ApiPropertyOptional({ description: "Booked before (ISO 8601, with offset)" })
  @IsOptional()
  @IsISO8601({ strict: true })
  endDate?: string;
}

export class CircuitEligibilityDto {
  @ApiProperty()
  @IsBoolean()
  eligible!: boolean;

  @ApiPropertyOptional({ example: "Two customer complaints on circuits" })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 240)
  reason?: string;
}
