import { SetMetadata } from "@nestjs/common";
import type { UserRole } from "../types/user-role.enum";

export const ROLES_KEY = "roles";

/** Restricts a route to the given roles; enforced by RolesGuard. */
export const Roles = (...roles: UserRole[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);
