import { Catch, HttpException, HttpStatus, Logger } from "@nestjs/common";
import type { ArgumentsHost, ExceptionFilter } from "@nestjs/common";
import type { Request, Response } from "express";
import type { ApiErrorBody } from "../http/api-response";

interface MongooseLikeError {
  name?: string;
  code?: number;
  path?: string;
  errors?: Record<string, { message?: string }>;
  keyValue?: Record<string, unknown>;
}

interface MulterLikeError {
  name?: string;
  code?: string;
}

const translateUploadError = (
  exception: unknown,
): { status: number; message: string; code: string } | null => {
  const error = exception as MulterLikeError | undefined;
  if (error?.name !== "MulterError") return null;
  if (error.code === "LIMIT_FILE_SIZE")
    return {
      status: HttpStatus.BAD_REQUEST,
      message: "The file exceeds the 5 MB upload limit",
      code: "DOCUMENT_TOO_LARGE",
    };
  return {
    status: HttpStatus.BAD_REQUEST,
    message: "The file could not be uploaded",
    code: "DOCUMENT_INVALID_TYPE",
  };
};

const translateDatabaseError = (
  exception: unknown,
): { status: number; message: string } | null => {
  const error = exception as MongooseLikeError | undefined;
  if (error?.name === "ValidationError") {
    const first = Object.values(error.errors ?? {})[0]?.message;
    return {
      status: HttpStatus.BAD_REQUEST,
      message: first ?? "The submitted record is not valid",
    };
  }
  if (error?.name === "CastError")
    return {
      status: HttpStatus.BAD_REQUEST,
      message: `"${error.path ?? "value"}" is not in a valid format`,
    };
  if (error?.name === "VersionError")
    return {
      status: HttpStatus.CONFLICT,
      message:
        "This record changed while you were editing it. Reload and retry.",
    };
  if (error?.code === 11000) {
    const field = Object.keys(error.keyValue ?? {})[0];
    return {
      status: HttpStatus.CONFLICT,
      message: field
        ? `That ${field} is already in use`
        : "That record already exists",
    };
  }
  return null;
};

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const response = context.getResponse<Response>();
    const request = context.getRequest<Request & { id?: string }>();

    const body = (
      status: number,
      message: string,
      extra: Partial<ApiErrorBody> = {},
    ): void => {
      const payload: ApiErrorBody = {
        success: false,
        message,
        ...extra,
        requestId: request.id,
        timestamp: new Date().toISOString(),
        path: request.originalUrl,
      };
      response.status(status).json(payload);
    };

    if (exception instanceof HttpException) {
      const raw = exception.getResponse();
      const payload =
        typeof raw === "object" && raw !== null
          ? (raw as Record<string, unknown>)
          : {};
      const rawMessage = payload.message ?? raw;
      const message = Array.isArray(rawMessage)
        ? String(rawMessage[0] ?? "Validation failed")
        : String(rawMessage || exception.message);
      body(exception.getStatus(), message, {
        ...(Array.isArray(rawMessage)
          ? { errors: rawMessage.map(String) }
          : {}),
        ...(typeof payload.code === "string" ? { code: payload.code } : {}),
        ...(payload.data !== undefined ? { data: payload.data } : {}),
      });
      return;
    }

    const upload = translateUploadError(exception);
    if (upload) {
      body(upload.status, upload.message, { code: upload.code });
      return;
    }

    const database = translateDatabaseError(exception);
    if (database) {
      body(database.status, database.message);
      return;
    }

    const error = exception as { message?: string; stack?: string } | undefined;
    this.logger.error(
      `Unhandled exception on ${request.method} ${request.originalUrl}: ${error?.message ?? String(exception)}`,
      error?.stack,
    );
    body(HttpStatus.INTERNAL_SERVER_ERROR, "Internal server error");
  }
}
