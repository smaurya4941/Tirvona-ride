import { HttpStatus, Injectable } from "@nestjs/common";
import type { OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectModel } from "@nestjs/mongoose";
import type { Model } from "mongoose";
import { Types } from "mongoose";
import { createHash, randomBytes } from "node:crypto";
import { ApiException, apiConflict, apiNotFound } from "../../common/exceptions/api.exception";
import { DomainEventsService } from "../../infrastructure/events/domain-events.service";
import { DriverProfile } from "../drivers/schemas/driver-profile.schema";
import { DriverLocationService } from "../locations/driver-location.service";
import { rideNotFound } from "../rides/ride-errors";
import { isTerminal } from "../rides/ride-state-machine";
import { Ride } from "../rides/schemas/ride.schema";
import type { RideDocument } from "../rides/schemas/ride.schema";
import { User } from "../users/schemas/user.schema";
import { RideShareToken } from "./schemas/ride-share-token.schema";
import {
  SHARED_STATUS_TEXT,
  effectiveShareExpiry,
  publicRideStatus,
  sharesDriverLocation,
} from "./share-ride-view";
import type { SharedRideView } from "./share-ride-view";

export interface ShareLinkView {
  url: string;
  token: string;
  expiresAt: Date;
  /** Ready-made text for the share sheet. */
  shareText: string;
}

/** At most this many live links per ride (each share-sheet use makes one). */
const MAX_ACTIVE_LINKS_PER_RIDE = 10;

const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

const linkNotFound = () => apiNotFound("This ride link is not valid", "SHARE_LINK_NOT_FOUND");
const linkExpired = () => new ApiException(HttpStatus.GONE, "This ride link has expired", "SHARE_LINK_EXPIRED");

/**
 * Share-my-ride links. The token is generated here (never by the app),
 * 192 bits of randomness, stored only as a hash. The public view is
 * read-only and sanitized, and a link dies shortly after the ride ends.
 */
@Injectable()
export class ShareRideService implements OnModuleInit {
  private readonly linkBaseUrl: string;
  private readonly maxHours: number;
  private readonly graceMinutes: number;

  constructor(
    @InjectModel(RideShareToken.name) private readonly tokenModel: Model<RideShareToken>,
    @InjectModel(Ride.name) private readonly rideModel: Model<Ride>,
    @InjectModel(DriverProfile.name) private readonly driverModel: Model<DriverProfile>,
    @InjectModel(User.name) private readonly userModel: Model<User>,
    private readonly driverLocations: DriverLocationService,
    private readonly events: DomainEventsService,
    config: ConfigService,
  ) {
    this.linkBaseUrl = config.getOrThrow<string>("shareRideLinkBaseUrl");
    this.maxHours = config.getOrThrow<number>("shareRideMaxHours");
    this.graceMinutes = config.getOrThrow<number>("shareRideGraceMinutes");
  }

  onModuleInit(): void {
    // A finished ride pulls every live link's expiry in to end + grace.
    this.events.on("ride.transitioned", async ({ ride, to }) => {
      if (!isTerminal(to)) return;
      await this.tokenModel
        .updateMany({ rideId: new Types.ObjectId(ride.rideId), isActive: true }, [
          {
            $set: {
              expiresAt: { $min: ["$expiresAt", new Date(Date.now() + this.graceMinutes * 60_000)] },
            },
          },
        ])
        .exec();
    });
  }

  async create(customerUserId: string, rideId: string): Promise<ShareLinkView> {
    const ride = await this.customerRide(customerUserId, rideId);
    if (isTerminal(ride.status)) throw apiConflict("Only an ongoing ride can be shared", "SHARE_NOT_ALLOWED");

    const token = randomBytes(24).toString("base64url");
    const expiresAt = new Date(Date.now() + this.maxHours * 60 * 60_000);
    await this.tokenModel.create({
      rideId: ride._id,
      customerId: ride.customerId,
      tokenHash: hashToken(token),
      expiresAt,
      isActive: true,
    });
    await this.retireExcess(ride._id);

    const customer = await this.userModel.findById(ride.customerId).select("firstName").lean().exec();
    const url = `${this.linkBaseUrl}/${token}`;
    return {
      url,
      token,
      expiresAt,
      shareText:
        `${customer?.firstName ?? "I"} ${customer ? "is" : "am"} sharing a Tirvona ride with you. ` +
        `Follow the trip live: ${url}`,
    };
  }

  /** Stops every live link of the ride. */
  async revoke(customerUserId: string, rideId: string): Promise<{ revoked: number }> {
    const ride = await this.customerRide(customerUserId, rideId);
    const result = await this.tokenModel
      .updateMany({ rideId: ride._id, isActive: true }, { $set: { isActive: false, revokedAt: new Date() } })
      .exec();
    return { revoked: result.modifiedCount };
  }

  async activeLinkCount(customerUserId: string, rideId: string): Promise<{ active: number }> {
    const ride = await this.customerRide(customerUserId, rideId);
    const active = await this.tokenModel
      .countDocuments({ rideId: ride._id, isActive: true, expiresAt: { $gt: new Date() } })
      .exec();
    return { active };
  }

  /** The public, unauthenticated read. */
  async publicView(token: string): Promise<SharedRideView> {
    // Cheap shape check first: never hash or query obvious garbage.
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw linkNotFound();
    const link = await this.tokenModel.findOne({ tokenHash: hashToken(token) }).exec();
    if (!link || !link.isActive) throw linkNotFound();

    const ride = await this.rideModel.findById(link.rideId).exec();
    if (!ride) throw linkNotFound();
    const endedAt = ride.completedAt ?? ride.cancelledAt ?? ride.expiredAt;
    const expiresAt = effectiveShareExpiry(link.expiresAt, isTerminal(ride.status) ? endedAt : undefined, this.graceMinutes);
    if (Date.now() > expiresAt.getTime()) throw linkExpired();

    void this.tokenModel
      .updateOne({ _id: link._id }, { $inc: { viewCount: 1 }, $set: { lastViewedAt: new Date() } })
      .exec()
      .catch(() => undefined);
    return this.sanitize(ride, expiresAt);
  }

  private async sanitize(ride: RideDocument, expiresAt: Date): Promise<SharedRideView> {
    const status = publicRideStatus(ride.status);
    let driver: SharedRideView["driver"] = null;
    if (ride.driverId && !["REQUESTED", "CANCELLED"].includes(status)) {
      const profile = await this.driverModel.findById(ride.driverId).select("userId ratingAverage ratingCount").lean().exec();
      const user = profile ? await this.userModel.findById(profile.userId).select("firstName").lean().exec() : null;
      if (user)
        driver = {
          firstName: user.firstName,
          ratingAverage: profile && (profile.ratingCount ?? 0) > 0 ? profile.ratingAverage : undefined,
        };
    }
    const live = sharesDriverLocation(ride.status) && ride.driverId
      ? await this.driverLocations.lastKnown(ride.driverId)
      : undefined;
    const vehicle = ride.vehicle && driver
      ? {
          type: ride.vehicle.vehicleType,
          registrationNumber: ride.vehicle.registrationNumber,
          description: [ride.vehicle.color, ride.vehicle.make, ride.vehicle.model].filter(Boolean).join(" ") || undefined,
        }
      : null;
    return {
      status,
      statusLabel: SHARED_STATUS_TEXT[status].label,
      statusMessage: SHARED_STATUS_TEXT[status].message,
      isLive: !isTerminal(ride.status),
      rideType: ride.rideType,
      driver,
      vehicle,
      pickup: { address: ride.pickup.address, latitude: ride.pickup.latitude, longitude: ride.pickup.longitude },
      destination: {
        address: ride.destination.address,
        latitude: ride.destination.latitude,
        longitude: ride.destination.longitude,
      },
      driverLocation: live ? { latitude: live.latitude, longitude: live.longitude, updatedAt: live.updatedAt } : null,
      startedAt: ride.startedAt,
      completedAt: ride.completedAt,
      cancelledAt: ride.cancelledAt ?? ride.expiredAt,
      lastUpdatedAt: new Date(),
      expiresAt,
    };
  }

  private async retireExcess(rideId: Types.ObjectId): Promise<void> {
    const excess = await this.tokenModel
      .find({ rideId, isActive: true })
      .sort({ createdAt: -1 })
      .skip(MAX_ACTIVE_LINKS_PER_RIDE)
      .select("_id")
      .lean()
      .exec();
    if (excess.length)
      await this.tokenModel
        .updateMany({ _id: { $in: excess.map((row) => row._id) } }, { $set: { isActive: false, revokedAt: new Date() } })
        .exec();
  }

  private async customerRide(customerUserId: string, rideId: string): Promise<RideDocument> {
    const ride = await this.rideModel
      .findOne({ _id: new Types.ObjectId(rideId), customerId: new Types.ObjectId(customerUserId) })
      .exec();
    if (!ride) throw rideNotFound();
    return ride;
  }
}
