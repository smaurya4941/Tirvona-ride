import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { IsLatitude, IsLongitude, IsNumber, IsOptional, IsString, Length, ValidateIf } from "class-validator";
import { LocationPointDto } from "../../locations/dto/location-point.dto";

const trim = ({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value);

/** Body of PUT /places/saved/:kind — the same point shape rides are booked with. */
export class SavePlaceDto extends LocationPointDto {
  @ApiPropertyOptional({ example: "Supertech Capetown, Tower B", description: "Short label; the address is shown when absent" })
  @IsOptional()
  @IsString()
  @Length(1, 120)
  name?: string;
}

/** Body of POST /places/saved/others — a labelled place of the rider's own. */
export class OtherSavedPlaceDto extends SavePlaceDto {
  @ApiProperty({ example: "Gym", description: "The rider's name for the place; unique per rider (case-insensitive)" })
  @Transform(trim)
  @IsString()
  @Length(1, 40)
  label!: string;
}

/**
 * Body of PATCH /places/saved/others/:id. Rename with `label`; move with the
 * whole point (`address`, `latitude` and `longitude` together).
 */
export class UpdateOtherSavedPlaceDto {
  @ApiPropertyOptional({ example: "Gym" })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 40)
  label?: string;

  @ApiPropertyOptional({ description: "Empty string removes the short name" })
  @IsOptional()
  @IsString()
  @Length(0, 120)
  name?: string;

  @ApiPropertyOptional({ example: "Prem Mandir, Vrindavan" })
  @ValidateIf((dto: UpdateOtherSavedPlaceDto) => dto.address !== undefined || dto.latitude !== undefined || dto.longitude !== undefined)
  @IsString()
  @Length(2, 200)
  address?: string;

  @ApiPropertyOptional({ example: 27.5714 })
  @ValidateIf((dto: UpdateOtherSavedPlaceDto) => dto.address !== undefined || dto.latitude !== undefined || dto.longitude !== undefined)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @IsLatitude()
  latitude?: number;

  @ApiPropertyOptional({ example: 77.6716 })
  @ValidateIf((dto: UpdateOtherSavedPlaceDto) => dto.address !== undefined || dto.latitude !== undefined || dto.longitude !== undefined)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @IsLongitude()
  longitude?: number;
}
