import { ApiProperty } from "@nestjs/swagger";
import { IsString, Length, Matches } from "class-validator";
import { IsMobileNumber } from "../../../common/phone/phone-number";
import { DeviceInfoDto } from "./device.dto";
import { OTP_CODE_PATTERN } from "./otp-code.dto";

export class VerifyOtpDto extends DeviceInfoDto {
  @ApiProperty({
    example: "+919812345678",
    description: "E.164; a 10-digit Indian mobile is accepted",
  })
  @IsMobileNumber()
  phone!: string;

  @ApiProperty({ example: "123456" })
  @Matches(OTP_CODE_PATTERN, { message: "otp must be a 6-digit code" })
  otp!: string;

  @ApiProperty({
    description: "verificationId returned by POST /auth/register",
  })
  @IsString()
  @Length(16, 128)
  verificationId!: string;
}
