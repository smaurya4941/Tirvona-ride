import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
  ValidateNested,
} from "class-validator";
import { ZoneStatus } from "../schemas/zone.schema";
import { MAX_ZONE_VERTICES, MIN_ZONE_VERTICES } from "../zone-geometry";

export class ZonePointDto {
  @ApiProperty({ example: 27.5806 })
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @IsLatitude()
  latitude!: number;

  @ApiProperty({ example: 77.7006 })
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @IsLongitude()
  longitude!: number;
}

export class CreateZoneDto {
  @ApiProperty({ example: "Vrindavan" })
  @IsString()
  @Length(2, 80)
  name!: string;

  @ApiPropertyOptional({ example: "Mathura" })
  @IsOptional()
  @IsString()
  @Length(1, 80)
  city?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 300)
  description?: string;

  @ApiPropertyOptional({ enum: ZoneStatus, default: ZoneStatus.ACTIVE })
  @IsOptional()
  @IsEnum(ZoneStatus)
  status?: ZoneStatus;

  @ApiProperty({ type: [ZonePointDto], description: "Boundary vertices in order around the edge (open or closed ring)" })
  @IsArray()
  @ArrayMinSize(MIN_ZONE_VERTICES)
  @ArrayMaxSize(MAX_ZONE_VERTICES + 1)
  @ValidateNested({ each: true })
  @Type(() => ZonePointDto)
  boundary!: ZonePointDto[];
}

export class UpdateZoneDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(2, 80)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 80)
  city?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 300)
  description?: string;

  @ApiPropertyOptional({ type: [ZonePointDto] })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(MIN_ZONE_VERTICES)
  @ArrayMaxSize(MAX_ZONE_VERTICES + 1)
  @ValidateNested({ each: true })
  @Type(() => ZonePointDto)
  boundary?: ZonePointDto[];
}

export class ZoneStatusDto {
  @ApiProperty({ enum: ZoneStatus })
  @IsEnum(ZoneStatus)
  status!: ZoneStatus;

  @ApiPropertyOptional({ description: "Why (required by the panel when deactivating)" })
  @IsOptional()
  @IsString()
  @Length(3, 240)
  reason?: string;
}

export class ListZonesQueryDto {
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

  @ApiPropertyOptional({ enum: ZoneStatus })
  @IsOptional()
  @IsEnum(ZoneStatus)
  status?: ZoneStatus;

  @ApiPropertyOptional({ description: "Name or city contains" })
  @IsOptional()
  @IsString()
  @Length(1, 60)
  search?: string;
}

export class ZoneLookupQueryDto {
  @ApiProperty()
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @IsLatitude()
  latitude!: number;

  @ApiProperty()
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @IsLongitude()
  longitude!: number;
}
