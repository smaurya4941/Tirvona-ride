import { ApiProperty } from "@nestjs/swagger";
import { IsString, Length } from "class-validator";

export class RefreshTokenDto {
  @ApiProperty()
  @IsString()
  @Length(20, 4096)
  refreshToken!: string;
}
