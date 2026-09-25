import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsInt, IsLatitude, IsLongitude, IsNumber, IsOptional, IsString, Length, Matches, Max, Min, ValidateIf } from "class-validator";

/** Optional rider position; both halves or neither. */
class NearQueryDto {
  @ApiPropertyOptional({ example: 27.5714, description: "Rider latitude, to rank nearby places first" })
  @ValidateIf((dto: NearQueryDto) => dto.longitude !== undefined || dto.latitude !== undefined)
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @IsLatitude()
  latitude?: number;

  @ApiPropertyOptional({ example: 77.6716 })
  @ValidateIf((dto: NearQueryDto) => dto.longitude !== undefined || dto.latitude !== undefined)
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @IsLongitude()
  longitude?: number;
}

/** Client-generated id tying keystrokes + the final tap into one search session. */
const SESSION_TOKEN = /^[A-Za-z0-9_-]{8,64}$/;

export class AutocompleteQueryDto extends NearQueryDto {
  @ApiProperty({ example: "banke bih", description: "What the rider typed" })
  @IsString()
  @Length(1, 100)
  q!: string;

  @ApiPropertyOptional({ example: "k3J9x0aQ-2mZ", description: "Autocomplete session token" })
  @IsOptional()
  @Matches(SESSION_TOKEN, { message: "sessionToken must be 8–64 URL-safe characters" })
  sessionToken?: string;

  @ApiPropertyOptional({ example: 8, minimum: 1, maximum: 10 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10)
  limit?: number;
}

export class ResolvePlaceQueryDto {
  @ApiProperty({ example: "osm:W123456", description: "A suggestion id from /places/autocomplete" })
  @IsString()
  @Length(3, 320)
  @Matches(/^(featured|osm|google):[A-Za-z0-9_-]+$/, { message: "id is not a place id" })
  id!: string;

  @ApiPropertyOptional({ example: "k3J9x0aQ-2mZ" })
  @IsOptional()
  @Matches(SESSION_TOKEN, { message: "sessionToken must be 8–64 URL-safe characters" })
  sessionToken?: string;
}

export class ReverseGeocodeQueryDto {
  @ApiProperty({ example: 27.5714 })
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @IsLatitude()
  latitude!: number;

  @ApiProperty({ example: 77.6716 })
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @IsLongitude()
  longitude!: number;
}

export class PopularPlacesQueryDto extends NearQueryDto {
  @ApiPropertyOptional({ example: 8, minimum: 1, maximum: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  limit?: number;
}
