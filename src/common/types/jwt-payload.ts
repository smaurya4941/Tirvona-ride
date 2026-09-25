import type { UserRole } from "./user-role.enum";

// Kept minimal deliberately — the access token is a bearer credential that
// travels through logs and client storage, so it must not carry PII.
export interface JwtAccessPayload {
  sub: string;
  role: UserRole;
}

export interface JwtRefreshPayload {
  sub: string;
  sid: string; // user_sessions._id, lets logout/rotation target one session
}

export interface AuthenticatedUser {
  userId: string;
  role: UserRole;
}
