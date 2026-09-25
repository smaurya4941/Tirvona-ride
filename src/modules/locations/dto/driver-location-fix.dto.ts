import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsDate,
  IsLatitude,
  IsLongitude,
  IsMongoId,
  IsNumber,
  IsOptional,
  Max,
  Min,
} from "class-validator";

const FINITE = { allowNaN: false, allowInfinity: false } as const;

/**
 * One GPS fix from the driver app, sent over the socket (`driver.location`)
 * or, as a fallback, `PATCH /drivers/location`.
 */
export class DriverLocationFixDto {
  @ApiProperty({ example: 27.5806 })
  @IsNumber(FINITE)
  @IsLatitude()
  latitude!: number;

  @ApiProperty({ example: 77.7006 })
  @IsNumber(FINITE)
  @IsLongitude()
  longitude!: number;

  /** Degrees clockwise from true north. */
  @ApiPropertyOptional({ example: 84.5 })
  @IsOptional()
  @IsNumber(FINITE)
  @Min(0)
  @Max(360)
  heading?: number;

  /** Metres per second. 90 m/s ≈ 324 km/h rejects obvious garbage. */
  @ApiPropertyOptional({ example: 8.2 })
  @IsOptional()
  @IsNumber(FINITE)
  @Min(0)
  @Max(90)
  speed?: number;

  /** Horizontal accuracy radius in metres. */
  @ApiPropertyOptional({ example: 6 })
  @IsOptional()
  @IsNumber(FINITE)
  @Min(0)
  @Max(10_000)
  accuracy?: number;

  /** Device time of the fix (ISO-8601). Defaults to server receive time. */
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  recordedAt?: Date;

  /**
   * The ride the driver believes they are on. Optional; when present it must
   * match the server's view, so a client can never stream into another ride.
   */
  @ApiPropertyOptional()
  @IsOptional()
  @IsMongoId()
  rideId?: string;
}
