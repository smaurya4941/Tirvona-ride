import { ApiProperty } from "@nestjs/swagger";
import { Matches } from "class-validator";
import { IsMobileNumber } from "../../../common/phone/phone-number";
import { DeviceInfoDto } from "./device.dto";
import { OTP_CODE_PATTERN } from "./otp-code.dto";

/** POST /auth/login/otp/request — sends a sign-in code on WhatsApp. */
export class RequestLoginOtpDto {
  @ApiProperty({ example: "+919812345678", description: "E.164; a 10-digit Indian mobile is accepted" })
  @IsMobileNumber()
  phone!: string;
}

/** POST /auth/login/otp/verify — signs in with the code. */
export class VerifyLoginOtpDto extends DeviceInfoDto {
  @ApiProperty({ example: "+919812345678", description: "E.164; a 10-digit Indian mobile is accepted" })
  @IsMobileNumber()
  phone!: string;

  @ApiProperty({ example: "123456" })
  @Matches(OTP_CODE_PATTERN, { message: "otp must be a 6-digit code" })
  otp!: string;
}
