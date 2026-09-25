import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsNumber, IsOptional, Max, Min } from "class-validator";

const MONEY = { allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 };

// Upper bounds are sanity rails against a fat-fingered extra zero, not
// commercial limits.
export class UpdatePricingDto {
  @ApiPropertyOptional({ example: 30 })
  @IsOptional()
  @IsNumber(MONEY)
  @Min(0)
  @Max(5_000)
  baseFare?: number;

  @ApiPropertyOptional({ example: 10 })
  @IsOptional()
  @IsNumber(MONEY)
  @Min(0)
  @Max(500)
  perKmRate?: number;

  @ApiPropertyOptional({ example: 1.5 })
  @IsOptional()
  @IsNumber(MONEY)
  @Min(0)
  @Max(100)
  perMinuteRate?: number;

  @ApiPropertyOptional({ example: 40 })
  @IsOptional()
  @IsNumber(MONEY)
  @Min(0)
  @Max(10_000)
  minimumFare?: number;
}
