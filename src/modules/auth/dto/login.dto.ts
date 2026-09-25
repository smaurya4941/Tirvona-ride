import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString, Matches } from "class-validator";

const PHONE_PATTERN = /^\+[1-9]\d{7,14}$/;

export class LoginDto {
  @ApiProperty({ example: "+919812345678" })
  @Matches(PHONE_PATTERN, {
    message: "phone must be in E.164 format, e.g. +919812345678",
  })
  phone!: string;

  @ApiProperty()
  @IsString()
  password!: string;

  @ApiPropertyOptional({ description: "Opaque client-generated device id" })
  @IsOptional()
  @IsString()
  deviceId?: string;

  @ApiPropertyOptional({ example: "android" })
  @IsOptional()
  @IsString()
  deviceType?: string;

  @ApiPropertyOptional({ example: "Pixel 8" })
  @IsOptional()
  @IsString()
  deviceName?: string;
}
