import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsBoolean, IsLatitude, IsLongitude, IsMongoId, IsNumber, IsOptional, ValidateIf } from "class-validator";

export class UpdateAvailabilityDto {
  @ApiProperty({ example: true })
  @IsBoolean()
  isOnline!: boolean;

  /** Current position; required the first time a driver goes online. */
  @ApiPropertyOptional({ example: 27.5806 })
  @ValidateIf((dto: UpdateAvailabilityDto) => dto.longitude !== undefined || dto.latitude !== undefined)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @IsLatitude()
  latitude?: number;

  @ApiPropertyOptional({ example: 77.7006 })
  @ValidateIf((dto: UpdateAvailabilityDto) => dto.longitude !== undefined || dto.latitude !== undefined)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @IsLongitude()
  longitude?: number;

  /** Which of the driver's active vehicles to drive; defaults to the newest. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsMongoId()
  vehicleId?: string;
}
