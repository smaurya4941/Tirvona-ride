import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import { IsBoolean, IsEnum, IsInt, IsNotEmpty, IsOptional, IsString, Matches, Max, MaxLength, Min } from "class-validator";
import { DevicePlatform } from "../schemas/device-token.schema";

export class ListNotificationsQueryDto {
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
  @Max(50)
  limit = 20;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @Transform(({ value }) => value === true || value === "true" || value === "1")
  @IsBoolean()
  unreadOnly?: boolean;
}

export class RegisterDeviceTokenDto {
  @ApiProperty({ description: "FCM registration token" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  // FCM tokens are URL-safe base64 with ':' separators; nothing else.
  @Matches(/^[A-Za-z0-9_:\-.]+$/, { message: "token is not a valid FCM registration token" })
  token!: string;

  @ApiProperty({ enum: DevicePlatform })
  @IsEnum(DevicePlatform)
  platform!: DevicePlatform;

  @ApiProperty({ description: "The app's install id (same as at login)" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  deviceId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  appVersion?: string;
}

export class DeactivateDeviceTokenDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  token!: string;
}
