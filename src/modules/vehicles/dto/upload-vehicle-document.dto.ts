import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsEnum, IsOptional, IsString } from "class-validator";
import { VehicleDocumentType } from "../schemas/vehicle-document.schema";

export class UploadVehicleDocumentDto {
  @ApiProperty({ enum: VehicleDocumentType })
  @IsEnum(VehicleDocumentType)
  documentType!: VehicleDocumentType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  documentNumber?: string;
}
