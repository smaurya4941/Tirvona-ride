import { Injectable, Logger } from "@nestjs/common";
import type { DomainEventHandler, DomainEventMap, DomainEventName } from "./domain-events";

/**
 * A small in-process event bus. Ride, payment and auth code publish what
 * *has happened*; notifications and safety subscribe. The producer never
 * waits for, or fails because of, a consumer: handlers run on the next
 * tick and their errors are logged.
 *
 * Single-node for V1. Swapping this for a Redis/queue-backed bus later keeps
 * every producer and consumer unchanged.
 */
@Injectable()
export class DomainEventsService {
  private readonly logger = new Logger(DomainEventsService.name);
  private readonly handlers = new Map<DomainEventName, Array<DomainEventHandler<DomainEventName>>>();
  private readonly pending = new Set<Promise<void>>();

  on<K extends DomainEventName>(name: K, handler: DomainEventHandler<K>): void {
    const list = this.handlers.get(name) ?? [];
    list.push(handler as DomainEventHandler<DomainEventName>);
    this.handlers.set(name, list);
  }

  emit<K extends DomainEventName>(name: K, event: DomainEventMap[K]): void {
    for (const handler of this.handlers.get(name) ?? []) {
      const run = new Promise<void>((resolve) => setImmediate(resolve))
        .then(() => handler(event))
        .catch((error: unknown) => {
          this.logger.error(
            `Handler for ${name} failed`,
            error instanceof Error ? error.stack : String(error),
          );
        });
      this.pending.add(run);
      void run.finally(() => this.pending.delete(run));
    }
  }

  /** Resolves once every handler started so far (and any they triggered) finished. */
  async drain(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
  }
}
