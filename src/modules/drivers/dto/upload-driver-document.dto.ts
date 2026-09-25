import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsEnum, IsOptional, IsString } from "class-validator";
import { DriverDocumentType } from "../schemas/driver-document.schema";

export class UploadDriverDocumentDto {
  @ApiProperty({ enum: DriverDocumentType })
  @IsEnum(DriverDocumentType)
  documentType!: DriverDocumentType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  documentNumber?: string;
}
