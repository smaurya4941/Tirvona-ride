import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import type { ErrorCode } from "../constants/error-codes";

// ApiExceptionFilter reads `message`/`code`/`data` off HttpException#getResponse(),
// so every thrown error carries a stable `code` the clients can branch on.
export interface ApiExceptionBody {
  message: string;
  code: ErrorCode;
  data?: unknown;
}

export const apiBadRequest = (
  message: string,
  code: ErrorCode,
  data?: unknown,
): BadRequestException => new BadRequestException({ message, code, data });

export const apiUnauthorized = (
  message: string,
  code: ErrorCode,
): UnauthorizedException => new UnauthorizedException({ message, code });

export const apiForbidden = (
  message: string,
  code: ErrorCode,
): ForbiddenException => new ForbiddenException({ message, code });

export const apiNotFound = (
  message: string,
  code: ErrorCode,
): NotFoundException => new NotFoundException({ message, code });

export const apiConflict = (
  message: string,
  code: ErrorCode,
): ConflictException => new ConflictException({ message, code });

export class ApiException extends HttpException {
  constructor(status: number, message: string, code: ErrorCode, data?: unknown) {
    super({ message, code, data }, status);
  }
}
