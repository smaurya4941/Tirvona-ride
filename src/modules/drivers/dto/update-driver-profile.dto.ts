import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsDateString, IsOptional, IsString, Length } from "class-validator";

export class UpdateDriverProfileDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(4, 30)
  licenseNumber?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  licenseExpiry?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  dateOfBirth?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 240)
  address?: string;
}
