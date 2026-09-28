import { Injectable, Logger } from "@nestjs/common";
import type { OnModuleInit } from "@nestjs/common";
import { DomainEventsService } from "../../infrastructure/events/domain-events.service";
import type { RideTransitionedEvent } from "../../infrastructure/events/domain-events";
import { RideStatus } from "../rides/ride-state-machine";
import { PromotionsService } from "./promotions.service";

/**
 * Keeps promo usage in step with the ride outcome without Rides importing
 * Promotions' write side: a completed ride redeems its reserved use with the
 * final discount; a cancelled / unmatched ride gives the use back.
 */
@Injectable()
export class PromoRideEventsListener implements OnModuleInit {
  private readonly logger = new Logger(PromoRideEventsListener.name);

  constructor(
    private readonly events: DomainEventsService,
    private readonly promotions: PromotionsService,
  ) {}

  onModuleInit(): void {
    this.events.on("ride.transitioned", (event) => this.handle(event));
  }

  async handle(event: RideTransitionedEvent): Promise<void> {
    if (!event.ride.promoCode) return;
    if (event.to === RideStatus.COMPLETED) {
      if (await this.promotions.redeem(event.ride.rideId, event.ride.promoDiscount ?? 0))
        this.logger.log(`Promo ${event.ride.promoCode} redeemed on ride ${event.ride.rideCode}`);
    } else if (event.to === RideStatus.CANCELLED || event.to === RideStatus.NO_DRIVER_AVAILABLE) {
      if (await this.promotions.release(event.ride.rideId))
        this.logger.log(`Promo ${event.ride.promoCode} released from ride ${event.ride.rideCode}`);
    }
  }
}
