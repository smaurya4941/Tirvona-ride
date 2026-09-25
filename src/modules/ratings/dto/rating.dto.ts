import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";

export class CreateRatingDto {
  @ApiProperty({ minimum: 1, maximum: 5, description: "Whole stars" })
  @IsInt({ message: "rating must be a whole number from 1 to 5" })
  @Min(1, { message: "rating must be a whole number from 1 to 5" })
  @Max(5, { message: "rating must be a whole number from 1 to 5" })
  rating!: number;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @Transform(({ value }) => (typeof value === "string" ? value.trim() || undefined : value))
  @MaxLength(500)
  comment?: string;
}
