import type { NextFunction, Request, Response } from "express";
import { randomUUID } from "node:crypto";

const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export const REQUEST_ID_HEADER = "x-request-id";

export function resolveRequestId(supplied: unknown): string {
  const value = String(supplied ?? "");
  return SAFE_REQUEST_ID.test(value) ? value : randomUUID();
}

export function requestIdMiddleware(
  request: Request & { id?: string },
  response: Response,
  next: NextFunction,
): void {
  request.id = resolveRequestId(request.headers[REQUEST_ID_HEADER]);
  response.setHeader(REQUEST_ID_HEADER, request.id);
  next();
}
