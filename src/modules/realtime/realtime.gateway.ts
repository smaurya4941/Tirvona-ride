import { Logger } from "@nestjs/common";
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
} from "@nestjs/websockets";
import type { OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit } from "@nestjs/websockets";
import type { Namespace, Socket } from "socket.io";
import { UserRole } from "../../common/types/user-role.enum";
import { DriverLocationFixDto } from "../locations/dto/driver-location-fix.dto";
import { LocationRelayService } from "./location-relay.service";
import {
  ClientMessage,
  REALTIME_NAMESPACE,
  RealtimeErrorCode,
  SessionEvent,
  rideRoom,
  userRoom,
} from "./realtime.constants";
import { RealtimeService } from "./realtime.service";
import type { Ack, SocketIdentity } from "./realtime.types";
import { RideRoomAccessService } from "./ride-room-access.service";
import { SocketAuthError, SocketAuthService } from "./socket-auth.service";
import { RideRoomDto, WindowRateLimiter, failure, validatePayload } from "./ws-payload";

type AppSocket = Socket & { data: SocketIdentity };

/** Longest a single setTimeout may wait (≈24.8 days); longer tokens re-arm. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * The realtime transport. It authenticates sockets, keeps them in the right
 * rooms and relays driver GPS. It never changes business state: ride actions
 * stay on REST, and every ride event it carries is emitted by RideEventsService
 * after MongoDB has committed the change.
 *
 * Rooms: `user:{userId}` (every socket of a user — offers, session events)
 * and `ride:{rideId}` (the ride's customer + its accepted driver).
 */
@WebSocketGateway({ namespace: REALTIME_NAMESPACE })
export class RealtimeGateway implements OnGatewayInit<Namespace>, OnGatewayConnection<AppSocket>, OnGatewayDisconnect<AppSocket> {
  private readonly logger = new Logger(RealtimeGateway.name);
  private readonly expiryTimers = new Map<string, NodeJS.Timeout>();
  /** Room joins are cheap but hit MongoDB; 30 per minute per socket is plenty. */
  private readonly joinLimiter = new WindowRateLimiter(30, 60_000);

  constructor(
    private readonly auth: SocketAuthService,
    private readonly access: RideRoomAccessService,
    private readonly relay: LocationRelayService,
    private readonly realtime: RealtimeService,
  ) {}

  afterInit(namespace: Namespace): void {
    namespace.use((socket, next) => {
      this.auth
        .authenticate(socket.handshake)
        .then((identity) => {
          socket.data = identity;
          next();
        })
        .catch((error: unknown) => {
          if (error instanceof SocketAuthError) return next(error);
          this.logger.error("Socket authentication failed", error instanceof Error ? error.stack : String(error));
          next(new SocketAuthError(RealtimeErrorCode.INTERNAL_ERROR, "Could not authenticate"));
        });
    });
    this.realtime.attach(namespace);
    this.logger.log(`Realtime gateway ready on namespace ${REALTIME_NAMESPACE}`);
  }

  async handleConnection(socket: AppSocket): Promise<void> {
    const identity = socket.data;
    if (!identity?.userId) {
      socket.disconnect(true);
      return;
    }
    try {
      await socket.join(userRoom(identity.userId));
      // Server-side room restoration: a reconnecting app is back in its ride
      // room before it asks, so no event is lost to a join race.
      const rideIds = await this.access.activeRideIds(identity);
      if (rideIds.length) await socket.join(rideIds.map(rideRoom));
      this.armExpiry(socket);
      socket.emit(SessionEvent.READY, {
        userId: identity.userId,
        role: identity.role,
        rideIds,
        recovered: socket.recovered,
        serverTime: new Date().toISOString(),
      });
      this.logger.debug(`Connected ${identity.role} ${identity.userId} (${socket.id}), rides [${rideIds.join(",")}]`);
    } catch (error) {
      this.logger.error("Socket connection setup failed", error instanceof Error ? error.stack : String(error));
      socket.disconnect(true);
    }
  }

  handleDisconnect(socket: AppSocket): void {
    const timer = this.expiryTimers.get(socket.id);
    if (timer) clearTimeout(timer);
    this.expiryTimers.delete(socket.id);
    this.joinLimiter.forget(socket.id);
    // Deliberately no availability change: a dropped connection is usually a
    // network blip. A driver who never comes back simply goes stale for
    // matching after DRIVER_LOCATION_STALE_SECONDS.
    this.logger.debug(`Disconnected ${socket.data?.userId ?? "anonymous"} (${socket.id})`);
  }

  // ── Client messages (all acknowledged) ──────────────────────────────

  @SubscribeMessage(ClientMessage.JOIN_RIDE)
  async joinRide(@ConnectedSocket() socket: AppSocket, @MessageBody() body: unknown): Promise<Ack> {
    if (!this.joinLimiter.allow(socket.id))
      return failure(RealtimeErrorCode.RATE_LIMITED, "Too many join requests");
    const payload = await validatePayload(RideRoomDto, body);
    if (!payload.ok) return payload.ack;

    const access = await this.access.check(socket.data, payload.value.rideId);
    if (!access.allowed)
      return access.reason === "RIDE_NOT_FOUND"
        ? failure(RealtimeErrorCode.RIDE_NOT_FOUND, "Ride not found")
        : failure(RealtimeErrorCode.RIDE_NOT_ACTIVE, "This ride is no longer live", { status: access.status });

    await socket.join(rideRoom(access.rideId));
    return { ok: true, rideId: access.rideId, status: access.status, stateVersion: access.stateVersion };
  }

  @SubscribeMessage(ClientMessage.LEAVE_RIDE)
  async leaveRide(@ConnectedSocket() socket: AppSocket, @MessageBody() body: unknown): Promise<Ack> {
    const payload = await validatePayload(RideRoomDto, body);
    if (!payload.ok) return payload.ack;
    await socket.leave(rideRoom(payload.value.rideId));
    return { ok: true, rideId: payload.value.rideId };
  }

  @SubscribeMessage(ClientMessage.DRIVER_LOCATION)
  async driverLocation(@ConnectedSocket() socket: AppSocket, @MessageBody() body: unknown): Promise<Ack> {
    const identity = socket.data;
    if (identity.role !== UserRole.DRIVER || !identity.driverId)
      return failure(RealtimeErrorCode.AUTH_FORBIDDEN, "Only drivers can share a location");

    const payload = await validatePayload(DriverLocationFixDto, body);
    if (!payload.ok) return payload.ack;

    try {
      const result = await this.relay.handle(identity.driverId, payload.value, {
        enforceRateLimit: true,
        exceptSocketId: socket.id,
      });
      if (!result.accepted) return failure(result.reason, LOCATION_REJECTION_MESSAGES[result.reason]);
      return {
        ok: true,
        persisted: result.persisted,
        rideId: result.relay?.rideId ?? null,
        rideStatus: result.relay?.status ?? null,
      };
    } catch (error) {
      this.logger.error("Driver location failed", error instanceof Error ? error.stack : String(error));
      return failure(RealtimeErrorCode.INTERNAL_ERROR, "Location could not be processed");
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  /**
   * A socket must not outlive the access token it was opened with. When the
   * token expires the client is told, and disconnected; it refreshes over
   * REST and reconnects with the new token.
   */
  private armExpiry(socket: AppSocket): void {
    const existing = this.expiryTimers.get(socket.id);
    if (existing) clearTimeout(existing);
    const remaining = socket.data.tokenExpiresAt - Date.now();
    const timer = setTimeout(
      () => {
        this.expiryTimers.delete(socket.id);
        if (socket.data.tokenExpiresAt > Date.now()) return this.armExpiry(socket);
        socket.emit(SessionEvent.EXPIRED, { reason: RealtimeErrorCode.AUTH_TOKEN_EXPIRED });
        socket.disconnect(true);
      },
      Math.min(Math.max(remaining, 0), MAX_TIMER_MS),
    );
    timer.unref();
    this.expiryTimers.set(socket.id, timer);
  }
}

const LOCATION_REJECTION_MESSAGES: Record<string, string> = {
  DRIVER_NOT_FOUND: "Driver profile not found",
  DRIVER_NOT_APPROVED: "Your driver account is not approved",
  DRIVER_OFFLINE: "Go online to share your location",
  RATE_LIMITED: "Location updates are arriving too fast",
  STALE_FIX: "This location is too old to use",
  LOW_ACCURACY: "GPS accuracy is too low",
  RIDE_MISMATCH: "That ride is not assigned to you",
};
