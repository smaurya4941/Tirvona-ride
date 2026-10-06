import { IsNotEmpty, IsString, MaxLength } from "class-validator";

export class DeleteAccountDto {
  /** Re-entered so a stolen phone or token cannot erase the account. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  password!: string;
}
