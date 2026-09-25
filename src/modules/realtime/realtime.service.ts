import { Injectable, Logger } from "@nestjs/common";
import type { Namespace } from "socket.io";
import { rideRoom, userRoom } from "./realtime.constants";
import type { RealtimeEnvelope, RideDelivery, SocketIdentity } from "./realtime.types";

/**
 * The only way the rest of the backend talks to connected apps. Services
 * call it *after* MongoDB has committed a change; it never decides anything.
 *
 * Single-node Socket.IO (in-memory adapter) in Phase 3. Adding the Redis
 * adapter later makes every method here cluster-wide without code changes.
 */
@Injectable()
export class RealtimeService {
  private readonly logger = new Logger(RealtimeService.name);
  private namespace?: Namespace;

  /** Called once by RealtimeGateway.afterInit. */
  attach(namespace: Namespace): void {
    this.namespace = namespace;
  }

  get isAttached(): boolean {
    return this.namespace !== undefined;
  }

  /**
   * Per-recipient delivery for ride status events. Each participant gets the
   * envelope built for them (customer view with OTP, driver view without) on
   * every socket they have — found through both the ride room and their user
   * room, so a socket that connected a moment ago still receives it. Anyone
   * else found in the ride room gets nothing and is removed from it.
   */
  async deliver(rideId: string, deliveries: RideDelivery[]): Promise<void> {
    const namespace = this.namespace;
    if (!namespace || deliveries.length === 0) return;
    const room = rideRoom(rideId);
    const byUser = new Map(deliveries.map((delivery) => [delivery.userId, delivery]));

    const rooms = [room, ...[...byUser.keys()].map((userId) => userRoom(userId))];
    const sockets = await namespace.in(rooms).fetchSockets();
    for (const socket of sockets) {
      const identity = socket.data as Partial<SocketIdentity>;
      const delivery = identity.userId ? byUser.get(identity.userId) : undefined;
      if (!delivery) {
        if (socket.rooms.has(room)) socket.leave(room);
        continue;
      }
      if (delivery.room === "join") socket.join(room);
      socket.emit(delivery.envelope.event, delivery.envelope);
      if (delivery.room === "leave") socket.leave(room);
    }
  }

  /** Same payload for everyone in the ride room (e.g. `ride.driver_arriving`). */
  emitToRide(rideId: string, envelope: RealtimeEnvelope): void {
    this.namespace?.to(rideRoom(rideId)).emit(envelope.event, envelope);
  }

  /**
   * High-frequency, fire-and-forget: volatile packets are dropped for a
   * client that is not ready instead of piling up in its buffer — a stale
   * location is worthless once a newer one exists.
   */
  emitVolatileToRide(rideId: string, envelope: RealtimeEnvelope, exceptSocketId?: string): void {
    const namespace = this.namespace;
    if (!namespace) return;
    let target = namespace.volatile.to(rideRoom(rideId));
    if (exceptSocketId) target = target.except(exceptSocketId);
    target.emit(envelope.event, envelope);
  }

  /** Everyone leaves a ride's room once the ride is over. */
  closeRideRoom(rideId: string): void {
    const room = rideRoom(rideId);
    this.namespace?.in(room).socketsLeave(room);
  }

  /** Drop every socket of a user (e.g. account blocked by an admin). */
  /** A non-ride event for every socket of one user (e.g. `notification.created`). */
  emitToUser(userId: string, event: string, payload: unknown): void {
    this.namespace?.to(userRoom(userId)).emit(event, payload);
  }

  disconnectUser(userId: string): void {
    this.namespace?.in(userRoom(userId)).disconnectSockets(true);
    this.logger.log(`Disconnected sockets of user ${userId}`);
  }
}
