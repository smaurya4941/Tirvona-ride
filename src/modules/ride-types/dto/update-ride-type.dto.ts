import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsBoolean, IsInt, IsOptional, IsString, Length, Max, Min } from "class-validator";

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

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  sortOrder?: number;
}
