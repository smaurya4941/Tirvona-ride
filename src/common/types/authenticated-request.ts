import type { Request } from "express";
import type { AuthenticatedUser } from "./jwt-payload";

export interface AuthenticatedRequest extends Request {
  user: AuthenticatedUser;
}
