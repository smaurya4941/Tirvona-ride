import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { IsBoolean, IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from "class-validator";
import { E164_PATTERN, normalizePhone } from "../phone";

const trim = ({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value);

export class CreateEmergencyContactDto {
  @ApiProperty({ example: "Papa" })
  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: "name is required" })
  @MaxLength(80)
  name!: string;

  @ApiProperty({ example: "+919876543210", description: "E.164; a 10-digit Indian mobile is accepted" })
  @Transform(({ value }) => normalizePhone(value))
  @IsString()
  @Matches(E164_PATTERN, { message: "phone must be a valid mobile number, e.g. +919876543210" })
  phone!: string;

  @ApiPropertyOptional({ example: "Father" })
  @IsOptional()
  @Transform(({ value }) => (typeof value === "string" ? value.trim() || undefined : value))
  @IsString()
  @MaxLength(40)
  relationship?: string;

  @ApiPropertyOptional({ description: "Make this the primary contact" })
  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;
}

export class UpdateEmergencyContactDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: "name cannot be empty" })
  @MaxLength(80)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => normalizePhone(value))
  @IsString()
  @Matches(E164_PATTERN, { message: "phone must be a valid mobile number, e.g. +919876543210" })
  phone?: string;

  /** Empty string clears it. */
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(40)
  relationship?: string;

  /** `true` makes this the primary contact (the previous one is demoted). */
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;
}
