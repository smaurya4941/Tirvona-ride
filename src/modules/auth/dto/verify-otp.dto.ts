import { ApiProperty } from "@nestjs/swagger";
import { Length, Matches } from "class-validator";

const PHONE_PATTERN = /^\+[1-9]\d{7,14}$/;

export class VerifyOtpDto {
  @ApiProperty({ example: "+919812345678" })
  @Matches(PHONE_PATTERN, {
    message: "phone must be in E.164 format, e.g. +919812345678",
  })
  phone!: string;

  @ApiProperty({ example: "123456" })
  @Length(6, 6)
  @Matches(/^\d{6}$/, { message: "otp must be a 6-digit code" })
  otp!: string;
}
