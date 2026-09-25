import { ApiProperty } from "@nestjs/swagger";
import { IsLatitude, IsLongitude, IsNumber, IsString, Length } from "class-validator";

export class LocationPointDto {
  @ApiProperty({ example: "Prem Mandir, Vrindavan" })
  @IsString()
  @Length(2, 200)
  address!: string;

  @ApiProperty({ example: 27.5714 })
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @IsLatitude()
  latitude!: number;

  @ApiProperty({ example: 77.6716 })
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @IsLongitude()
  longitude!: number;
}
