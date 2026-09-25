import { ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  Length,
} from "class-validator";

export class UpdateProfileDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 60)
  firstName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 60)
  lastName?: string;

  @ApiPropertyOptional({ enum: ["male", "female", "other"] })
  @IsOptional()
  @IsIn(["male", "female", "other"])
  gender?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  dob?: string;
}
