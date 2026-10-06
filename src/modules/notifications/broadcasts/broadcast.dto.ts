import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsDate,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from "class-validator";
import {
  BroadcastAudience,
  BroadcastDeepLink,
  BroadcastStatus,
} from "./broadcast.schema";

export class CreateBroadcastDto {
  @ApiProperty({ example: "Temple road closed on Sunday" })
  @IsString()
  @Length(3, 120)
  title!: string;

  @ApiProperty({
    example: "Parikrama Marg is closed 6–10 am. Pickups will use Gate 2.",
  })
  @IsString()
  @Length(3, 500)
  message!: string;

  @ApiProperty({ enum: BroadcastAudience })
  @IsEnum(BroadcastAudience)
  audience!: BroadcastAudience;

  @ApiPropertyOptional({
    enum: BroadcastDeepLink,
    default: BroadcastDeepLink.NONE,
  })
  @IsOptional()
  @IsEnum(BroadcastDeepLink)
  deepLink?: BroadcastDeepLink;

  @ApiPropertyOptional({
    description: "Schedule for later; omit to keep as a draft",
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  scheduledAt?: Date;
}

export class UpdateBroadcastDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(3, 120)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(3, 500)
  message?: string;

  @ApiPropertyOptional({ enum: BroadcastAudience })
  @IsOptional()
  @IsEnum(BroadcastAudience)
  audience?: BroadcastAudience;

  @ApiPropertyOptional({ enum: BroadcastDeepLink })
  @IsOptional()
  @IsEnum(BroadcastDeepLink)
  deepLink?: BroadcastDeepLink;

  @ApiPropertyOptional({
    nullable: true,
    description: "null turns a scheduled broadcast back into a draft",
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  scheduledAt?: Date | null;
}

export class ListBroadcastsQueryDto {
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

  @ApiPropertyOptional({ enum: BroadcastStatus })
  @IsOptional()
  @IsEnum(BroadcastStatus)
  status?: BroadcastStatus;
}

export class AudienceQueryDto {
  @ApiProperty({ enum: BroadcastAudience })
  @IsIn(Object.values(BroadcastAudience))
  audience!: BroadcastAudience;
}
