import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from "class-validator";
import { VehicleType } from "../schemas/vehicle.schema";

export class CreateVehicleDto {
  @ApiProperty({ enum: VehicleType })
  @IsEnum(VehicleType)
  vehicleType!: VehicleType;

  @ApiProperty({ example: "UP32AB1234" })
  @IsString()
  @Length(4, 15)
  registrationNumber!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 60)
  make?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 60)
  model?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 40)
  color?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1980)
  @Max(new Date().getFullYear() + 1)
  manufactureYear?: number;
}
