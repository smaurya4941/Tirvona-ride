import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsBoolean,
  IsEnum,
  IsISO8601,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from "class-validator";
import { PaymentGateway, PaymentStatus } from "../interfaces/payment-status";

/**
 * "Create payment for this ride." Deliberately no amount, currency or
 * method: the server reads the ride's final fare and decides everything.
 */
export class CreatePaymentDto {
  @ApiProperty({ description: "The completed ride to pay for" })
  @IsMongoId()
  rideId!: string;
}

const ORDER_ID = /^order_[A-Za-z0-9]{6,40}$/;
const PAYMENT_ID = /^pay_[A-Za-z0-9]{6,40}$/;

/** What Razorpay Checkout hands the app on success, forwarded untouched. */
export class VerifyPaymentDto {
  @ApiProperty({ description: "Tirvona payment id returned by /payments/create" })
  @IsMongoId()
  paymentId!: string;

  @ApiProperty({ example: "order_Pq8XkLm2Nn3Rst" })
  @Matches(ORDER_ID, { message: "razorpayOrderId is not a Razorpay order id" })
  razorpayOrderId!: string;

  @ApiProperty({ example: "pay_Pq8Y1Ab2Cd3Efg" })
  @Matches(PAYMENT_ID, { message: "razorpayPaymentId is not a Razorpay payment id" })
  razorpayPaymentId!: string;

  @ApiProperty({ description: "razorpay_signature from the checkout success callback" })
  @Matches(/^[a-f0-9]{64}$/i, { message: "razorpaySignature must be a 64-character hex digest" })
  razorpaySignature!: string;
}

/**
 * The checkout reported a failure or the customer closed it. Advisory only:
 * it can move an unpaid ride to FAILED so the app offers a retry, but it
 * can never override a payment Razorpay reports as captured.
 */
export class PaymentFailureDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Matches(ORDER_ID)
  razorpayOrderId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(PAYMENT_ID)
  razorpayPaymentId?: string;

  @ApiPropertyOptional({ example: "BAD_REQUEST_ERROR" })
  @IsOptional()
  @IsString()
  @Length(1, 60)
  code?: string;

  @ApiPropertyOptional({ example: "Payment failed due to incorrect UPI PIN" })
  @IsOptional()
  @IsString()
  @Length(1, 500)
  description?: string;

  @ApiPropertyOptional({ description: "true when the customer dismissed the checkout" })
  @IsOptional()
  @IsBoolean()
  cancelled?: boolean;
}

class PageQueryDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10_000)
  page = 1;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;
}

export class PaymentHistoryQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: PaymentStatus })
  @IsOptional()
  @IsEnum(PaymentStatus)
  status?: PaymentStatus;
}

export class AdminPaymentsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: PaymentStatus })
  @IsOptional()
  @IsEnum(PaymentStatus)
  status?: PaymentStatus;

  @ApiPropertyOptional({ enum: PaymentGateway, description: "RAZORPAY (online) or CASH" })
  @IsOptional()
  @IsEnum(PaymentGateway)
  gateway?: PaymentGateway;

  @ApiPropertyOptional({ description: "Created on/after (ISO date or date-time)" })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ description: "Created before the end of this day (ISO date) or this instant" })
  @IsOptional()
  @IsISO8601()
  to?: string;

  @ApiPropertyOptional({ description: "Ride code or ride id" })
  @IsOptional()
  @IsString()
  @Length(1, 40)
  ride?: string;

  @ApiPropertyOptional({ description: "Customer phone or name" })
  @IsOptional()
  @IsString()
  @Length(1, 60)
  customer?: string;

  @ApiPropertyOptional({ description: "Driver code, phone or name" })
  @IsOptional()
  @IsString()
  @Length(1, 60)
  driver?: string;

  @ApiPropertyOptional({ description: "Tirvona payment id, pay_… or order_…" })
  @IsOptional()
  @IsString()
  @Length(1, 60)
  payment?: string;
}
