import type { INestApplicationContext } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { IoAdapter } from "@nestjs/platform-socket.io";
import type { Server, ServerOptions } from "socket.io";

/**
 * Server-wide Socket.IO settings, read from configuration rather than
 * hardcoded in the gateway decorator.
 *
 * - WebSocket transport only: the mobile apps speak it natively, and it needs
 *   no sticky sessions when the API later runs behind a load balancer.
 * - Connection-state recovery: a client that drops for less than
 *   REALTIME_RECOVERY_WINDOW_MS reconnects into the same rooms and receives
 *   the non-volatile events it missed. Apps still re-sync over REST after
 *   every reconnect; recovery just narrows the gap. Note: recovery appends
 *   an offset argument to every emitted event; the Dart client delivers
 *   `[body, offset]`, which the app unwraps (`eventBody` in
 *   realtime_client.dart). Acks are unaffected.
 * - Small max payload: clients only ever send tiny messages.
 */
export class RealtimeIoAdapter extends IoAdapter {
  private readonly config: ConfigService;

  constructor(app: INestApplicationContext) {
    super(app);
    this.config = app.get(ConfigService);
  }

  override createIOServer(port: number, options?: ServerOptions): Server {
    return super.createIOServer(port, {
      ...options,
      serveClient: false,
      transports: ["websocket"],
      cors: { origin: this.config.getOrThrow<string[]>("corsOrigins"), credentials: true },
      pingInterval: this.config.getOrThrow<number>("realtimePingIntervalMs"),
      pingTimeout: this.config.getOrThrow<number>("realtimePingTimeoutMs"),
      maxHttpBufferSize: 16 * 1024,
      connectionStateRecovery: {
        maxDisconnectionDuration: this.config.getOrThrow<number>("realtimeRecoveryWindowMs"),
        // Recovered sockets keep the identity set at their original handshake;
        // the token-expiry timer is re-armed on reconnect.
        skipMiddlewares: true,
      },
    }) as Server;
  }
}
