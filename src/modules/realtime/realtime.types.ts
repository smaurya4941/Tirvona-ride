import type { UserRole } from "../../common/types/user-role.enum";

/** What the server knows about a socket, fixed at the handshake. */
export interface SocketIdentity {
  userId: string;
  role: UserRole.CUSTOMER | UserRole.DRIVER;
  /** driver_profiles._id — present for drivers only. */
  driverId?: string;
  /** Epoch ms at which the access token used for the handshake expires. */
  tokenExpiresAt: number;
}

/**
 * The one envelope every ride event uses:
 * `{ event, rideId, status, stateVersion, timestamp, data, ride? }`.
 *
 * `ride` is the recipient's own view (customer or driver) — the same shape
 * `GET /rides/:id` returns — so a client can render without a round trip.
 * High-frequency events (`ride.location_updated`) omit it and keep `data`
 * minimal.
 */
export interface RealtimeEnvelope<TData = Record<string, unknown>> {
  event: string;
  rideId: string;
  status?: string;
  stateVersion?: number;
  timestamp: string;
  data: TData;
  ride?: unknown;
}

/** One recipient of a per-user event, and whether they belong in the ride room. */
export interface RideDelivery {
  userId: string;
  envelope: RealtimeEnvelope;
  room: "join" | "leave" | "keep";
}

export type Ack<T extends Record<string, unknown> = Record<string, unknown>> =
  | ({ ok: true } & T)
  | { ok: false; code: string; message: string; details?: unknown };
