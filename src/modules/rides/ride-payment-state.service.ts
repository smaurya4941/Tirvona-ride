import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import type { Model, QueryFilter, UpdateQuery } from "mongoose";
import { Types } from "mongoose";
import { rideNotFound } from "./ride-errors";
import { RideEventsService } from "./ride-events.service";
import { RidePaymentStatus } from "./ride-payment-status";
import { RideStatus } from "./ride-state-machine";
import { Ride } from "./schemas/ride.schema";
import type { RideDocument, RidePaymentSummary } from "./schemas/ride.schema";

export interface RidePaymentChange {
  rideId: Types.ObjectId;
  /** Only applied while the ride's payment status is one of these. */
  from: readonly RidePaymentStatus[];
  to: RidePaymentStatus;
  /** Fields of the denormalised `ride.payment` summary to set. */
  payment?: Partial<RidePaymentSummary>;
  /** Summary fields to clear (e.g. a stale failure reason on retry). */
  clear?: Array<keyof RidePaymentSummary>;
}

/**
 * The only writer of `ride.paymentStatus` / `ride.payment` after completion
 * (the completion transition itself sets PENDING). PaymentsModule calls it;
 * it never decides anything about money — it applies a compare-and-set on
 * the ride and publishes `ride.payment_updated`.
 */
@Injectable()
export class RidePaymentStateService {
  constructor(
    @InjectModel(Ride.name) private readonly rideModel: Model<Ride>,
    private readonly events: RideEventsService,
  ) {}

  /** The customer's own ride, or 404 (never confirms someone else's ride exists). */
  async findForCustomer(customerUserId: string, rideId: string): Promise<RideDocument> {
    const ride = await this.rideModel
      .findOne({ _id: new Types.ObjectId(rideId), customerId: new Types.ObjectId(customerUserId) })
      .exec();
    if (!ride) throw rideNotFound();
    return ride;
  }

  async findById(rideId: Types.ObjectId | string): Promise<RideDocument | null> {
    return this.rideModel.findById(rideId).exec();
  }

  async findManyByIds(rideIds: Types.ObjectId[]): Promise<RideDocument[]> {
    return rideIds.length ? this.rideModel.find({ _id: { $in: rideIds } }).exec() : [];
  }

  /** Rides matching a ride code prefix or an exact id (admin search). */
  async findIdsByReference(reference: string): Promise<Types.ObjectId[]> {
    const term = reference.trim();
    if (/^[0-9a-f]{24}$/i.test(term)) return [new Types.ObjectId(term)];
    const escaped = term.toUpperCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rides = await this.rideModel
      .find({ rideCode: { $regex: `^${escaped}` } })
      .select("_id")
      .limit(200)
      .lean()
      .exec();
    return rides.map((ride) => ride._id);
  }

  /** Completed rides the customer has not paid for yet. */
  async outstanding(): Promise<{ rides: number; amount: number }> {
    const [row] = await this.rideModel
      .aggregate<{ rides: number; amount: number }>([
        {
          $match: {
            status: RideStatus.COMPLETED,
            "fare.finalFare": { $gt: 0 },
            paymentStatus: {
              $in: [
                RidePaymentStatus.NOT_REQUIRED,
                RidePaymentStatus.PENDING,
                RidePaymentStatus.ORDER_CREATED,
                RidePaymentStatus.PROCESSING,
                RidePaymentStatus.FAILED,
              ],
            },
          },
        },
        { $group: { _id: null, rides: { $sum: 1 }, amount: { $sum: "$fare.finalFare" } } },
      ])
      .exec();
    return { rides: row?.rides ?? 0, amount: row?.amount ?? 0 };
  }

  /**
   * Compare-and-set on the payment status of a COMPLETED ride. Returns the
   * updated ride, or null when the ride was not in one of `from` (someone
   * else — a webhook, a second verify — already moved it).
   */
  async apply(change: RidePaymentChange): Promise<RideDocument | null> {
    const from = new Set(change.from);
    // Rides completed before Phase 4 still hold the schema default.
    if (from.has(RidePaymentStatus.PENDING)) from.add(RidePaymentStatus.NOT_REQUIRED);

    const set: Record<string, unknown> = { paymentStatus: change.to };
    for (const [key, value] of Object.entries(change.payment ?? {}))
      if (value !== undefined) set[`payment.${key}`] = value;
    const update: UpdateQuery<Ride> = { $set: set, $inc: { stateVersion: 1 } };
    if (change.clear?.length)
      update.$unset = Object.fromEntries(change.clear.map((key) => [`payment.${key}`, 1]));

    const filter: QueryFilter<Ride> = {
      _id: change.rideId,
      status: RideStatus.COMPLETED,
      paymentStatus: { $in: [...from] },
    };
    const ride = await this.rideModel
      .findOneAndUpdate(filter, update, { returnDocument: "after", runValidators: true })
      .exec();
    if (ride) this.events.paymentUpdated(ride._id, { paymentStatus: ride.paymentStatus }, ride);
    return ride;
  }
}
