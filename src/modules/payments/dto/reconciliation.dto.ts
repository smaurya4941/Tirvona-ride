import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from "class-validator";

export class ReconciliationRunDto {
  @ApiProperty({
    description: "Window start (ISO date-time)",
    example: "2026-09-28T00:00:00+05:30",
  })
  @IsISO8601()
  from!: string;

  @ApiPropertyOptional({
    description: "Window end (ISO date-time); default now",
  })
  @IsOptional()
  @IsISO8601()
  to?: string;
}

export class ResolveExceptionDto {
  @ApiProperty({ example: "Refunded manually from the Razorpay dashboard" })
  @IsString()
  @Length(3, 300)
  note!: string;
}

export class ReconciliationRunsQueryDto {
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
