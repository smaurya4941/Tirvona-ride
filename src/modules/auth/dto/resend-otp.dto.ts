import { ApiProperty } from "@nestjs/swagger";
import { IsString, Length } from "class-validator";
import { IsMobileNumber } from "../../../common/phone/phone-number";

export class ResendOtpDto {
  @ApiProperty({ example: "+919812345678", description: "E.164; a 10-digit Indian mobile is accepted" })
  @IsMobileNumber()
  phone!: string;

  @ApiProperty({ description: "verificationId returned by POST /auth/register" })
  @IsString()
  @Length(16, 128)
  verificationId!: string;
}
