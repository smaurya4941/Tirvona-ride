import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import { IsEnum, IsInt, IsLatitude, IsLongitude, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";
import { SosStatus } from "../sos-lifecycle";

const optionalText = ({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() || undefined : value);

export class TriggerSosDto {
  /** Omitted when the phone could not get a fix in time; the server falls back. */
  @ApiPropertyOptional({ example: 27.5714 })
  @IsOptional()
  @IsLatitude()
  latitude?: number;

  @ApiPropertyOptional({ example: 77.6716 })
  @IsOptional()
  @IsLongitude()
  longitude?: number;

  @ApiPropertyOptional({ description: "GPS accuracy radius in metres" })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100_000)
  accuracyMeters?: number;

  @ApiPropertyOptional({ description: "Reverse-geocoded address, if the phone has one" })
  @IsOptional()
  @Transform(optionalText)
  @IsString()
  @MaxLength(300)
  address?: string;

  @ApiPropertyOptional({ description: "Optional short message for the safety team" })
  @IsOptional()
  @Transform(optionalText)
  @IsString()
  @MaxLength(500)
  message?: string;
}

export class ListSosQueryDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10_000)
  page = 1;

  @ApiPropertyOptional({ default: 25 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 25;

  @ApiPropertyOptional({ enum: SosStatus })
  @IsOptional()
  @IsEnum(SosStatus)
  status?: SosStatus;

  /** `true`: TRIGGERED + ACKNOWLEDGED + IN_PROGRESS. */
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => value === true || value === "true" || value === "1")
  open?: boolean;
}

export class UpdateSosDto {
  @ApiProperty({ enum: [SosStatus.ACKNOWLEDGED, SosStatus.IN_PROGRESS, SosStatus.RESOLVED, SosStatus.CANCELLED] })
  @IsEnum(SosStatus)
  status!: SosStatus;

  @ApiPropertyOptional({ description: "What was done (required to resolve or cancel)" })
  @IsOptional()
  @Transform(optionalText)
  @IsString()
  @MaxLength(2000)
  note?: string;
}
