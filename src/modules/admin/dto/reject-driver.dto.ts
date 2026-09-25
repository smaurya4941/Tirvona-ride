import { ApiProperty } from "@nestjs/swagger";
import { IsString, Length } from "class-validator";

export class RejectDriverDto {
  @ApiProperty({ example: "Driving license document is unclear" })
  @IsString()
  @Length(3, 300)
  reason!: string;
}
