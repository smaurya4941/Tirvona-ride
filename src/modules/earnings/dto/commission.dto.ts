import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsEnum, IsISO8601, IsNumber, IsOptional, IsString, Length, Max, Min } from "class-validator";
import { CommissionType } from "../interfaces/earning-status";

export class UpdateCommissionDto {
  @ApiPropertyOptional({ enum: CommissionType, default: CommissionType.PERCENTAGE })
  @IsOptional()
  @IsEnum(CommissionType)
  type?: CommissionType;

  @ApiProperty({ example: 20, description: "Percent of the gross fare kept by Tirvona" })
  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  value!: number;

  @ApiPropertyOptional({
    example: "2026-10-01T00:00:00+05:30",
    description: "When the new rate takes over (default: now). Cannot be in the past.",
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  effectiveFrom?: string;

  @ApiPropertyOptional({ example: "Festive season rate" })
  @IsOptional()
  @IsString()
  @Length(1, 240)
  note?: string;
}
