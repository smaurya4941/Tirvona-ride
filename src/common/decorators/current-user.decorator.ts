import { createParamDecorator } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import type { AuthenticatedRequest } from "../types/authenticated-request";
import type { AuthenticatedUser } from "../types/jwt-payload";

/** The `{ userId, role }` pair JwtAuthGuard attaches to the request. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    return request.user;
  },
);
