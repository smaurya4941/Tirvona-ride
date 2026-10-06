import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from "class-validator";

export class CreateRatingDto {
  @ApiProperty({ minimum: 1, maximum: 5, description: "Whole stars" })
  @IsInt({ message: "rating must be a whole number from 1 to 5" })
  @Min(1, { message: "rating must be a whole number from 1 to 5" })
  @Max(5, { message: "rating must be a whole number from 1 to 5" })
  rating!: number;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @Transform(({ value }) =>
    typeof value === "string" ? value.trim() || undefined : value,
  )
  @MaxLength(500)
  comment?: string;
}

const toBoolean = ({ value }: { value: unknown }) =>
  value === "true" ? true : value === "false" ? false : value;

/** GET /drivers/me/ratings/reviews — newest first, cursor-paginated. */
export class DriverReviewsQueryDto {
  @ApiPropertyOptional({ description: "nextCursor from the previous page" })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  cursor?: string;

  @ApiPropertyOptional({ default: 20, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit = 20;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 5,
    description: "Only ratings with this many stars",
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  stars?: number;

  @ApiPropertyOptional({
    description: "Only ratings that came with a written comment",
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  withComment?: boolean;
}
