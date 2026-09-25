import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import { IsBoolean, IsEnum, IsInt, IsMongoId, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min, MinLength } from "class-validator";
import { ComplaintCategory, ComplaintPriority, ComplaintStatus } from "../complaint-rules";

const trim = ({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value);
const optionalText = ({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() || undefined : value);

export class CreateComplaintDto {
  @ApiPropertyOptional({ description: "The ride this is about (required for ride-specific categories)" })
  @IsOptional()
  @IsMongoId()
  rideId?: string;

  @ApiProperty({ enum: ComplaintCategory })
  @IsEnum(ComplaintCategory)
  category!: ComplaintCategory;

  @ApiProperty({ example: "Driver took a longer route" })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MinLength(3)
  @MaxLength(120)
  subject!: string;

  @ApiProperty({ example: "The driver did not follow the route shown in the app…" })
  @Transform(trim)
  @IsString()
  @MinLength(10, { message: "Please describe the problem in a little more detail (at least 10 characters)" })
  @MaxLength(2000)
  description!: string;
}

export class ListComplaintsQueryDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10_000)
  page = 1;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;

  @ApiPropertyOptional({ enum: ComplaintStatus })
  @IsOptional()
  @IsEnum(ComplaintStatus)
  status?: ComplaintStatus;
}

export class AdminListComplaintsQueryDto extends ListComplaintsQueryDto {
  @ApiPropertyOptional({ enum: ComplaintCategory })
  @IsOptional()
  @IsEnum(ComplaintCategory)
  category?: ComplaintCategory;

  @ApiPropertyOptional({ enum: ComplaintPriority })
  @IsOptional()
  @IsEnum(ComplaintPriority)
  priority?: ComplaintPriority;

  /** Ticket code, ride code, or the user's phone/name. */
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(optionalText)
  @IsString()
  @MaxLength(80)
  search?: string;
}

export class UpdateComplaintDto {
  @ApiPropertyOptional({ enum: ComplaintStatus })
  @IsOptional()
  @IsEnum(ComplaintStatus)
  status?: ComplaintStatus;

  @ApiPropertyOptional({ enum: ComplaintPriority })
  @IsOptional()
  @IsEnum(ComplaintPriority)
  priority?: ComplaintPriority;

  /** Shown to the user; required when resolving. */
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(optionalText)
  @IsString()
  @MaxLength(2000)
  resolution?: string;

  /** Internal note, kept in the ticket history only. */
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(optionalText)
  @IsString()
  @MaxLength(2000)
  note?: string;

  @ApiPropertyOptional({ description: "Assign the ticket to the calling admin" })
  @IsOptional()
  @IsBoolean()
  assignToMe?: boolean;
}
