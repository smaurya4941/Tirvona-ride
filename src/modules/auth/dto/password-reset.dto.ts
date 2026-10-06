import { ApiProperty } from "@nestjs/swagger";
import { IsString, Length, Matches } from "class-validator";
import { IsMobileNumber } from "../../../common/phone/phone-number";
import { DeviceInfoDto } from "./device.dto";
import { OTP_CODE_PATTERN } from "./otp-code.dto";
import { IsStrongPassword } from "../../../common/validation/password";

/** POST /auth/password/forgot — sends a reset code on WhatsApp. */
export class ForgotPasswordDto {
  @ApiProperty({
    example: "+919812345678",
    description: "E.164; a 10-digit Indian mobile is accepted",
  })
  @IsMobileNumber()
  phone!: string;
}

/** POST /auth/password/verify-otp — trades the code for a one-time reset token. */
export class VerifyPasswordResetOtpDto {
  @ApiProperty({
    example: "+919812345678",
    description: "E.164; a 10-digit Indian mobile is accepted",
  })
  @IsMobileNumber()
  phone!: string;

  @ApiProperty({ example: "123456" })
  @Matches(OTP_CODE_PATTERN, { message: "otp must be a 6-digit code" })
  otp!: string;
}

/** POST /auth/password/reset — sets the new password and signs the user in. */
export class ResetPasswordDto extends DeviceInfoDto {
  @ApiProperty({
    description: "resetToken returned by POST /auth/password/verify-otp",
  })
  @IsString()
  @Length(16, 128)
  resetToken!: string;

  @ApiProperty()
  @IsStrongPassword("newPassword")
  newPassword!: string;
}
