import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateIf,
} from "class-validator";
import { RefundDriverImpact, RefundReason, RefundStatus, RefundTarget } from "../interfaces/refund-status";

/** Reasons an admin may pick (EXTERNAL is reserved for dashboard refunds). */
const ADMIN_REASONS = Object.values(RefundReason).filter((reason) => reason !== RefundReason.EXTERNAL);

/**
 * An admin refund. `amount` is rupees; leave it out for "refund everything
 * still refundable". The server validates it against what was captured and
 * what is already refunded or on its way — never trusting the panel's math.
 */
export class CreateRefundDto {
  @ApiPropertyOptional({ description: "Rupees, up to 2 decimals. Omit for a full refund of what remains.", example: 50 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(1)
  @Max(1_000_000)
  amount?: number;

  @ApiProperty({ enum: ADMIN_REASONS })
  @IsEnum(ADMIN_REASONS, { message: `reason must be one of ${ADMIN_REASONS.join(", ")}` })
  reason!: RefundReason;

  @ApiProperty({ description: "Why (kept in the audit trail)", example: "Driver took a long detour" })
  @IsString()
  @Length(3, 300)
  note!: string;

  @ApiPropertyOptional({
    enum: RefundDriverImpact,
    description: "Default depends on the reason (fare/cancellation/admin: PROPORTIONAL; support/system/duplicate: NONE)",
  })
  @IsOptional()
  @IsEnum(RefundDriverImpact)
  driverImpact?: RefundDriverImpact;

  @ApiPropertyOptional({ enum: RefundTarget, default: RefundTarget.PAYMENT })
  @IsOptional()
  @IsEnum(RefundTarget)
  target?: RefundTarget;

  @ApiPropertyOptional({ description: "The duplicate capture to refund (target DUPLICATE_CAPTURE)", example: "pay_Pq8Y1Ab2Cd3Efg" })
  @ValidateIf((dto: CreateRefundDto) => dto.target === RefundTarget.DUPLICATE_CAPTURE)
  @Matches(/^pay_[A-Za-z0-9]{6,40}$/, { message: "razorpayPaymentId is not a Razorpay payment id" })
  razorpayPaymentId?: string;

  @ApiProperty({ description: "Client-generated UUID; resending the same key never refunds twice" })
  @IsUUID()
  idempotencyKey!: string;
}

export class ReviewRefundDto {
  @ApiProperty({ enum: RefundDriverImpact, description: "Whether the driver shares this dashboard refund" })
  @IsEnum(RefundDriverImpact)
  driverImpact!: RefundDriverImpact;

  @ApiProperty({ example: "Refunded by support for a fare dispute" })
  @IsString()
  @Length(3, 300)
  note!: string;
}

export class AdminRefundsQueryDto {
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

  @ApiPropertyOptional({ enum: RefundStatus })
  @IsOptional()
  @IsEnum(RefundStatus)
  status?: RefundStatus;

  @ApiPropertyOptional({ enum: RefundReason })
  @IsOptional()
  @IsEnum(RefundReason)
  reason?: RefundReason;

  @ApiPropertyOptional({ description: "Only dashboard refunds awaiting review" })
  @IsOptional()
  @Transform(({ value }) => (value === "true" ? true : value === "false" ? false : value))
  @IsBoolean()
  needsReview?: boolean;
}
