import { Injectable } from "@nestjs/common";
import type {
  CallHandler,
  ExecutionContext,
  NestInterceptor,
} from "@nestjs/common";
import type { Request } from "express";
import type { Observable } from "rxjs";
import { catchError, from, mergeMap, throwError } from "rxjs";
import { removeFile } from "../http/file-upload";

/**
 * Deletes the temp upload when anything after multer fails — DTO
 * validation, an ownership check, a status rule. Must be listed after
 * FileInterceptor so `request.file` is already populated.
 */
@Injectable()
export class UploadCleanupInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    return next.handle().pipe(
      catchError((error: unknown) => {
        const path = request.file?.path;
        if (!path) return throwError(() => error);
        return from(removeFile(path)).pipe(
          mergeMap(() => throwError(() => error)),
        );
      }),
    );
  }
}
