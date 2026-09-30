import { ApiProperty, ApiPropertyOptional, PartialType } from "@nestjs/swagger";
import { IsBoolean, IsInt, IsLatitude, IsLongitude, IsNumber, IsOptional, IsString, Length, Max, Min } from "class-validator";

/** Admin: add a popular destination. */
export class CreatePopularPlaceDto {
  @ApiProperty({ example: "Noida City Centre" })
  @IsString()
  @Length(2, 80)
  name!: string;

  @ApiProperty({ example: "Sector 32, Noida", description: "Second line of the list row" })
  @IsString()
  @Length(2, 120)
  secondaryText!: string;

  @ApiProperty({ example: "Noida", description: "Area label that groups places in the admin list" })
  @IsString()
  @Length(2, 60)
  city!: string;

  @ApiProperty({ example: 28.5753, description: "Drop-off point (main gate)" })
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @IsLatitude()
  latitude!: number;

  @ApiProperty({ example: 77.3561 })
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @IsLongitude()
  longitude!: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @ApiPropertyOptional({ default: 100, description: "Lower first when the rider's position is unknown" })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
  sortOrder?: number;
}

/** Admin: change any subset of a popular destination. */
export class UpdatePopularPlaceDto extends PartialType(CreatePopularPlaceDto) {}
