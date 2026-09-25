import { HttpStatus } from "@nestjs/common";
import type { NotFoundException } from "@nestjs/common";
import { ApiException, apiNotFound } from "../../common/exceptions/api.exception";
import type { ErrorCode } from "../../common/constants/error-codes";
import type { RideStatus } from "./ride-state-machine";

// 404 whether the ride is missing or simply not yours — never confirms that
// another customer's/driver's ride exists.
export const rideNotFound = (): NotFoundException => apiNotFound("Ride not found", "RIDE_NOT_FOUND");

/** 409 carrying the ride's real status so clients can resync their UI. */
export const rideConflict = (
  message: string,
  currentStatus: RideStatus,
  code: ErrorCode = "INVALID_STATUS_TRANSITION",
): ApiException => new ApiException(HttpStatus.CONFLICT, message, code, { currentStatus });
