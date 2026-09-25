import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Length,
  Matches,
  MinLength,
} from "class-validator";
import { UserRole } from "../../../common/types/user-role.enum";

const PHONE_PATTERN = /^\+[1-9]\d{7,14}$/;
const STRONG_PASSWORD =
  /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^\da-zA-Z]).{8,}$/;

// role deliberately excludes ADMIN — see spec §14. Admin accounts are seeded,
// never self-registered.
const REGISTERABLE_ROLES = [UserRole.CUSTOMER, UserRole.DRIVER] as const;

export class RegisterDto {
  @ApiProperty()
  @IsString()
  @Length(1, 60)
  firstName!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 60)
  lastName?: string;

  @ApiProperty({ example: "+919812345678" })
  @Matches(PHONE_PATTERN, {
    message: "phone must be in E.164 format, e.g. +919812345678",
  })
  phone!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiProperty()
  @IsString()
  @MinLength(8)
  @Matches(STRONG_PASSWORD, {
    message:
      "password must contain an uppercase letter, a lowercase letter, a number and a symbol",
  })
  password!: string;

  @ApiProperty({ enum: REGISTERABLE_ROLES })
  @IsIn(REGISTERABLE_ROLES)
  role!: (typeof REGISTERABLE_ROLES)[number];

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
