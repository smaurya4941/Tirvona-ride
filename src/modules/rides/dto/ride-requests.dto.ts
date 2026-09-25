import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsEnum,
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
import { RideTypeCode } from "../../ride-types/schemas/ride-type.schema";
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
  @ApiProperty({ enum: RideTypeCode })
  @IsEnum(RideTypeCode)
  rideType!: RideTypeCode;
}

export class CancelRideDto {
  @ApiPropertyOptional({ example: "Plans changed" })
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
  @Matches(/^\d{4}$/, { message: "otp must be the 4-digit code shown to the customer" })
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
}
