import { ApiProperty } from "@nestjs/swagger";
import { IsString, Length } from "class-validator";
import { IsStrongPassword } from "../../../common/validation/password";

export class ChangePasswordDto {
  @ApiProperty()
  @IsString()
  @Length(1, 128)
  currentPassword!: string;

  @ApiProperty()
  @IsStrongPassword("newPassword")
  newPassword!: string;
}
