import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsEnum, IsOptional, Matches } from "class-validator";
import { LOCAL_DATE, ReportPreset } from "../report-range";

export class ReportQueryDto {
  @ApiPropertyOptional({ enum: ReportPreset, default: ReportPreset.LAST_7_DAYS })
  @IsOptional()
  @IsEnum(ReportPreset)
  preset?: ReportPreset;

  @ApiPropertyOptional({ example: "2026-09-01", description: "Custom range start (local date, inclusive)" })
  @IsOptional()
  @Matches(LOCAL_DATE, { message: "from must be a date like 2026-09-01" })
  from?: string;

  @ApiPropertyOptional({ example: "2026-09-26", description: "Custom range end (local date, inclusive)" })
  @IsOptional()
  @Matches(LOCAL_DATE, { message: "to must be a date like 2026-09-26" })
  to?: string;
}
