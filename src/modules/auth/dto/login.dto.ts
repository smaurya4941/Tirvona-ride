import { ApiProperty } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { IsString, Length, Matches } from "class-validator";
import {
  E164_PATTERN,
  normalizePhone,
} from "../../../common/phone/phone-number";
import { DeviceInfoDto } from "./device.dto";

export class LoginDto extends DeviceInfoDto {
  // Normalised like signup ("98765 43210" = "+919876543210"), but only
  // checked for E.164 so older accounts with any stored number still sign in.
  @ApiProperty({ example: "+919812345678" })
  @Transform(({ value }) => normalizePhone(value))
  @IsString()
  @Matches(E164_PATTERN, {
    message: "phone must be in E.164 format, e.g. +919812345678",
  })
  phone!: string;

  @ApiProperty()
  @IsString()
  @Length(1, 128)
  password!: string;
}
