import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString, Length } from "class-validator";

/** Device metadata recorded on the session a successful sign-in creates. */
export class DeviceInfoDto {
  @ApiPropertyOptional({ description: "Opaque client-generated device id" })
  @IsOptional()
  @IsString()
  @Length(1, 200)
  deviceId?: string;

  @ApiPropertyOptional({ example: "android" })
  @IsOptional()
  @IsString()
  @Length(1, 200)
  deviceType?: string;

  @ApiPropertyOptional({ example: "Pixel 8" })
  @IsOptional()
  @IsString()
  @Length(1, 200)
  deviceName?: string;
}
