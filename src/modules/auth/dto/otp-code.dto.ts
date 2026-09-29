import { ApiProperty } from "@nestjs/swagger";
import { Matches } from "class-validator";

export const OTP_CODE_PATTERN = /^\d{6}$/;

/** POST /auth/phone/verify-otp — the signed-in user's own number. */
export class PhoneOtpDto {
  @ApiProperty({ example: "123456" })
  @Matches(OTP_CODE_PATTERN, { message: "otp must be a 6-digit code" })
  otp!: string;
}
