import { ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import {
  IsDateString,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Length,
  ValidateIf,
} from "class-validator";

const trim = ({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value);

/** PATCH /users/me — every field optional; only the ones sent change. */
export class UpdateProfileDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 60)
  firstName?: string;

  @ApiPropertyOptional({ description: "Empty string removes the last name" })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(0, 60)
  lastName?: string;

  @ApiPropertyOptional({
    nullable: true,
    description: "A new address is stored unverified; null or an empty string removes the email",
  })
  @IsOptional()
  @Transform(({ value }) => (typeof value === "string" ? value.trim().toLowerCase() || null : value))
  @ValidateIf((_, value) => value !== null)
  @IsEmail()
  @Length(3, 254)
  email?: string | null;

  @ApiPropertyOptional({ enum: ["male", "female", "other"] })
  @IsOptional()
  @IsIn(["male", "female", "other"])
  gender?: string;

  @ApiPropertyOptional({ example: "1994-08-15", description: "Calendar date (YYYY-MM-DD) in the past" })
  @IsOptional()
  @IsDateString({ strict: true })
  dob?: string;
}
