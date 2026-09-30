import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import {
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
  ValidateIf,
} from "class-validator";
import { DriverDocumentType } from "../../drivers/schemas/driver-document.schema";
import { VehicleDocumentType } from "../../vehicles/schemas/vehicle-document.schema";
import { VehicleType } from "../../vehicles/schemas/vehicle.schema";
import { DriverChangeStatus } from "../schemas/driver-change-request.schema";

const trim = ({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value);
const trimOrUndefined = ({ value }: { value: unknown }) =>
  typeof value === "string" ? value.trim() || undefined : value;
const plate = ({ value }: { value: unknown }) =>
  typeof value === "string" ? value.replace(/\s+/g, "").toUpperCase() : value;

/** POST /drivers/me/change-requests/profile — licence and date of birth. */
export class DriverProfileChangeDto {
  @ApiPropertyOptional({ example: "UP3220210012345" })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(4, 30)
  licenseNumber?: string;

  @ApiPropertyOptional({ example: "2034-05-31", description: "Must be in the future" })
  @IsOptional()
  @IsDateString({ strict: true })
  licenseExpiry?: string;

  @ApiPropertyOptional({ example: "1990-01-31" })
  @IsOptional()
  @IsDateString({ strict: true })
  dateOfBirth?: string;
}

/** POST /drivers/me/change-requests/vehicle — details of one of the driver's active vehicles. */
export class VehicleChangeDto {
  @ApiProperty()
  @IsMongoId()
  vehicleId!: string;

  @ApiPropertyOptional({ enum: VehicleType })
  @IsOptional()
  @IsEnum(VehicleType)
  vehicleType?: VehicleType;

  @ApiPropertyOptional({ example: "UP32AB1234" })
  @IsOptional()
  @Transform(plate)
  @IsString()
  @Length(4, 15)
  @Matches(/^[A-Z0-9]+$/, { message: "registrationNumber may contain only letters and digits" })
  registrationNumber?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 60)
  make?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 60)
  model?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 40)
  color?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1980)
  @Max(new Date().getFullYear() + 1)
  manufactureYear?: number;
}

export const DOCUMENT_SCOPES = ["DRIVER", "VEHICLE"] as const;
export type DocumentScope = (typeof DOCUMENT_SCOPES)[number];

/** Multipart fields of POST /drivers/me/change-requests/document (plus `file`). */
export class DocumentChangeDto {
  @ApiProperty({ enum: DOCUMENT_SCOPES })
  @IsIn(DOCUMENT_SCOPES)
  scope!: DocumentScope;

  @ApiProperty({ description: "A DriverDocumentType for DRIVER, a VehicleDocumentType for VEHICLE" })
  // Which enum applies depends on `scope`; the service checks it.
  @IsIn([...Object.values(DriverDocumentType), ...Object.values(VehicleDocumentType)])
  documentType!: string;

  @ApiPropertyOptional({ description: "Required for VEHICLE documents" })
  @ValidateIf((dto: DocumentChangeDto) => dto.scope === "VEHICLE")
  @IsMongoId()
  vehicleId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trimOrUndefined)
  @IsString()
  @Length(1, 40)
  documentNumber?: string;

  @ApiPropertyOptional({ example: "2027-03-31", description: "When the renewed document expires (future)" })
  @IsOptional()
  @Transform(trimOrUndefined)
  @IsDateString({ strict: true })
  expiryDate?: string;
}

export class DriverChangeListQueryDto {
  @ApiPropertyOptional({ enum: DriverChangeStatus })
  @IsOptional()
  @IsEnum(DriverChangeStatus)
  status?: DriverChangeStatus;
}

export class AdminDriverChangeQueryDto {
  @ApiPropertyOptional({ enum: DriverChangeStatus, default: DriverChangeStatus.PENDING })
  @IsOptional()
  @IsEnum(DriverChangeStatus)
  status: DriverChangeStatus = DriverChangeStatus.PENDING;

  @ApiPropertyOptional()
  @IsOptional()
  @IsMongoId()
  driverId?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10_000)
  page = 1;

  @ApiPropertyOptional({ default: 25 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 25;
}

export class RejectDriverChangeDto {
  @ApiProperty({ example: "The insurance document is unreadable" })
  @Transform(trim)
  @IsString()
  @Length(3, 500)
  reason!: string;
}
