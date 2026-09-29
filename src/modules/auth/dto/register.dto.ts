import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { IsEmail, IsIn, IsOptional, IsString, Length, Matches } from "class-validator";
import { UserRole } from "../../../common/types/user-role.enum";
import { IsMobileNumber } from "../../../common/phone/phone-number";
import { DeviceInfoDto } from "./device.dto";

const STRONG_PASSWORD =
  /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^\da-zA-Z]).{8,}$/;

// role deliberately excludes ADMIN — see spec §14. Admin accounts are seeded,
// never self-registered.
const REGISTERABLE_ROLES = [UserRole.CUSTOMER, UserRole.DRIVER] as const;

const trim = ({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value);
const trimOrUndefined = ({ value }: { value: unknown }) =>
  typeof value === "string" ? value.trim() || undefined : value;

/**
 * POST /auth/register — starts a signup. No account exists until the
 * WhatsApp code is verified (POST /auth/verify-otp). Device fields are
 * accepted for backward compatibility; the session is created at verify.
 */
export class RegisterDto extends DeviceInfoDto {
  @ApiProperty()
  @Transform(trim)
  @IsString()
  @Length(1, 60)
  firstName!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trimOrUndefined)
  @IsString()
  @Length(1, 60)
  lastName?: string;

  @ApiProperty({ example: "+919812345678", description: "E.164; a 10-digit Indian mobile is accepted" })
  @IsMobileNumber()
  phone!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => (typeof value === "string" ? value.trim().toLowerCase() || undefined : value))
  @IsEmail()
  @Length(3, 254)
  email?: string;

  @ApiProperty()
  @IsString()
  @Length(8, 128)
  @Matches(STRONG_PASSWORD, {
    message:
      "password must contain an uppercase letter, a lowercase letter, a number and a symbol",
  })
  password!: string;

  @ApiProperty({ enum: REGISTERABLE_ROLES })
  @IsIn(REGISTERABLE_ROLES)
  role!: (typeof REGISTERABLE_ROLES)[number];
}
