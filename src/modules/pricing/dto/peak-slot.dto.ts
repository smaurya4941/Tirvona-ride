import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { ArrayMaxSize, ArrayUnique, IsArray, IsBoolean, IsNumber, IsOptional, IsString, Length, Matches, Max, Min } from "class-validator";
import { RIDE_TYPE_CODE_PATTERN } from "../../ride-types/schemas/ride-type.schema";
import { TIME_OF_DAY_PATTERN } from "../peak-pricing";

const trim = ({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value);
const TIME_MESSAGE = "must be a 24-hour time such as 16:00";

export class CreatePeakSlotDto {
  @ApiProperty({ example: "Evening Peak" })
  @Transform(trim)
  @IsString()
  @Length(2, 60)
  name!: string;

  @ApiProperty({ example: "16:00", description: "HH:mm in the business time zone; inclusive" })
  @Matches(TIME_OF_DAY_PATTERN, { message: `startTime ${TIME_MESSAGE}` })
  startTime!: string;

  @ApiProperty({ example: "20:00", description: "HH:mm; exclusive. Earlier than startTime means the slot crosses midnight" })
  @Matches(TIME_OF_DAY_PATTERN, { message: `endTime ${TIME_MESSAGE}` })
  endTime!: string;

  @ApiProperty({ example: 50, description: "Percent added to the per-km rate (0.01 – 300)" })
  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(300)
  hikePercent!: number;

  @ApiPropertyOptional({ default: true, description: "true = every ride type; false = only `rideTypes`" })
  @IsOptional()
  @IsBoolean()
  appliesToAll?: boolean;

  @ApiPropertyOptional({ example: ["CAB"] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ArrayUnique()
  @Matches(RIDE_TYPE_CODE_PATTERN, { each: true, message: "each ride type must be a valid code" })
  rideTypes?: string[];

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdatePeakSlotDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 60)
  name?: string;

  @ApiPropertyOptional({ example: "16:00" })
  @IsOptional()
  @Matches(TIME_OF_DAY_PATTERN, { message: `startTime ${TIME_MESSAGE}` })
  startTime?: string;

  @ApiPropertyOptional({ example: "20:00" })
  @IsOptional()
  @Matches(TIME_OF_DAY_PATTERN, { message: `endTime ${TIME_MESSAGE}` })
  endTime?: string;

  @ApiPropertyOptional({ example: 50 })
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(300)
  hikePercent?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  appliesToAll?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ArrayUnique()
  @Matches(RIDE_TYPE_CODE_PATTERN, { each: true, message: "each ride type must be a valid code" })
  rideTypes?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class SetPeakSlotStatusDto {
  @ApiProperty()
  @IsBoolean()
  isActive!: boolean;
}
