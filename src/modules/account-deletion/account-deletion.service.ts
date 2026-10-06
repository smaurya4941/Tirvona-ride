import { Injectable, Logger } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Types } from "mongoose";
import type { Model } from "mongoose";
import {
  apiBadRequest,
  apiConflict,
  apiForbidden,
  apiNotFound,
} from "../../common/exceptions/api.exception";
import { UserRole } from "../../common/types/user-role.enum";
import { DomainEventsService } from "../../infrastructure/events/domain-events.service";
import { TokenService } from "../auth/token.service";
import { StorageService } from "../storage/storage.service";
import { OtpVerification } from "../auth/schemas/otp-verification.schema";
import { OtpSendQuota } from "../auth/schemas/otp-send-quota.schema";
import { PasswordReset } from "../auth/schemas/password-reset.schema";
import { PendingSignup } from "../auth/schemas/pending-signup.schema";
import {
  Cancellation,
  CancellationFeeStatus,
} from "../cancellations/schemas/cancellation.schemas";
import { DriverChangeRequest } from "../driver-changes/schemas/driver-change-request.schema";
import { DriverDocument } from "../drivers/schemas/driver-document.schema";
import {
  DriverProfile,
  DriverStatus,
} from "../drivers/schemas/driver-profile.schema";
import {
  AdjustmentStatus,
  EarningStatus,
} from "../earnings/interfaces/earning-status";
import { DriverEarning } from "../earnings/schemas/driver-earning.schema";
import { DriverEarningAdjustment } from "../earnings/schemas/driver-earning-adjustment.schema";
import { DeviceToken } from "../notifications/schemas/device-token.schema";
import { Notification } from "../notifications/schemas/notification.schema";
import { SavedPlace } from "../places/schemas/saved-place.schema";
import { Ride } from "../rides/schemas/ride.schema";
import { EmergencyContact } from "../safety/schemas/emergency-contact.schema";
import { RideShareToken } from "../safety/schemas/ride-share-token.schema";
import { ProfileImage } from "../users/schemas/profile-image.schema";
import { User, UserStatus } from "../users/schemas/user.schema";
import { UsersService } from "../users/users.service";
import { AccountStatusService } from "../users/account-status.service";
import { Vehicle } from "../vehicles/schemas/vehicle.schema";
import { VehicleDocument } from "../vehicles/schemas/vehicle-document.schema";

export interface AccountDeletionResult {
  deleted: true;
}

/**
 * Self-service account deletion (Google Play "account deletion" policy).
 *
 * What is erased at once: everything that identifies the person — name,
 * phone, email, password, birth date, photo, saved places, emergency
 * contacts, notifications, push tokens, sessions, and for drivers the
 * licence details, document files and vehicle details. What stays, with no
 * personal data attached, because the law and other people's records need
 * it: rides, payments, refunds, earnings, payouts, ratings, support tickets
 * and SOS incidents (docs/account-deletion/README.md).
 *
 * The account is refused (409) while money or a trip is unsettled; support
 * resolves it and the person can try again.
 */
@Injectable()
export class AccountDeletionService {
  private readonly logger = new Logger(AccountDeletionService.name);

  constructor(
    @InjectModel(User.name) private readonly users: Model<User>,
    @InjectModel(Ride.name) private readonly rides: Model<Ride>,
    @InjectModel(Cancellation.name)
    private readonly cancellations: Model<Cancellation>,
    @InjectModel(DriverProfile.name)
    private readonly drivers: Model<DriverProfile>,
    @InjectModel(DriverDocument.name)
    private readonly driverDocuments: Model<DriverDocument>,
    @InjectModel(DriverChangeRequest.name)
    private readonly changeRequests: Model<DriverChangeRequest>,
    @InjectModel(DriverEarning.name)
    private readonly earnings: Model<DriverEarning>,
    @InjectModel(DriverEarningAdjustment.name)
    private readonly adjustments: Model<DriverEarningAdjustment>,
    @InjectModel(Vehicle.name) private readonly vehicles: Model<Vehicle>,
    @InjectModel(VehicleDocument.name)
    private readonly vehicleDocuments: Model<VehicleDocument>,
    @InjectModel(ProfileImage.name)
    private readonly profileImages: Model<ProfileImage>,
    @InjectModel(SavedPlace.name)
    private readonly savedPlaces: Model<SavedPlace>,
    @InjectModel(EmergencyContact.name)
    private readonly emergencyContacts: Model<EmergencyContact>,
    @InjectModel(Notification.name)
    private readonly notifications: Model<Notification>,
    @InjectModel(DeviceToken.name)
    private readonly deviceTokens: Model<DeviceToken>,
    @InjectModel(RideShareToken.name)
    private readonly shareTokens: Model<RideShareToken>,
    @InjectModel(PasswordReset.name)
    private readonly passwordResets: Model<PasswordReset>,
    @InjectModel(PendingSignup.name)
    private readonly pendingSignups: Model<PendingSignup>,
    @InjectModel(OtpVerification.name)
    private readonly otps: Model<OtpVerification>,
    @InjectModel(OtpSendQuota.name)
    private readonly otpQuotas: Model<OtpSendQuota>,
    private readonly usersService: UsersService,
    private readonly accountStatus: AccountStatusService,
    private readonly tokens: TokenService,
    private readonly events: DomainEventsService,
    private readonly storage: StorageService,
  ) {}

  async deleteAccount(
    userId: string,
    password: string,
  ): Promise<AccountDeletionResult> {
    const user = await this.usersService.findByIdWithPassword(userId);
    if (!user || user.status === UserStatus.DELETED)
      throw apiNotFound("Account not found", "USER_NOT_FOUND");
    if (user.role !== UserRole.CUSTOMER && user.role !== UserRole.DRIVER)
      throw apiForbidden(
        "This account type cannot be deleted from the app",
        "ACCOUNT_DELETION_NOT_ALLOWED",
      );
    if (!(await this.usersService.verifyPassword(user, password)))
      throw apiBadRequest(
        "Password is incorrect",
        "ACCOUNT_DELETION_PASSWORD_INVALID",
      );

    const id = new Types.ObjectId(userId);
    await this.assertNothingUnsettled(id, user.role);

    // Claim the account. From here on every guard (access token check, ride
    // booking, going online) sees a DELETED user, so nothing new can start.
    const phone = user.phone;
    const claimed = await this.users
      .findOneAndUpdate(
        { _id: id, status: { $in: [UserStatus.ACTIVE, UserStatus.INACTIVE] } },
        { $set: { status: UserStatus.DELETED, deletedAt: new Date() } },
      )
      .exec();
    if (!claimed)
      throw apiConflict(
        "This account is already being deleted",
        "ACCOUNT_DELETION_IN_PROGRESS",
      );
    this.accountStatus.invalidate(userId);

    try {
      // A ride booked between the check above and the claim is caught here.
      await this.assertNothingUnsettled(id, user.role);
    } catch (error) {
      await this.users
        .updateOne(
          { _id: id },
          { $set: { status: claimed.status }, $unset: { deletedAt: 1 } },
        )
        .exec();
      this.accountStatus.invalidate(userId);
      throw error;
    }

    await this.tokens.revokeAllForUser(userId);
    if (user.role === UserRole.DRIVER) await this.eraseDriver(id);
    await this.erasePersonalData(id, phone);
    this.events.emit("auth.sessions_revoked", {
      userId,
      reason: "ACCOUNT_DELETED",
    });
    this.logger.log(`Account ${userId} (${user.role}) deleted by its owner`);
    return { deleted: true };
  }

  /** Throws 409 with a reason the app shows verbatim. */
  private async assertNothingUnsettled(
    userId: Types.ObjectId,
    role: UserRole,
  ): Promise<void> {
    const activeRide = await this.rides
      .exists({
        isActive: true,
        ...(role === UserRole.DRIVER
          ? { driverUserId: userId }
          : { customerId: userId }),
      })
      .exec();
    if (activeRide)
      throw apiConflict(
        "You have a ride in progress. Finish or cancel it, then delete your account.",
        "ACCOUNT_DELETION_BLOCKED",
        { reason: "ACTIVE_RIDE" },
      );

    if (role === UserRole.CUSTOMER) {
      const due = await this.cancellations
        .exists({ customerId: userId, feeStatus: CancellationFeeStatus.DUE })
        .exec();
      if (due)
        throw apiConflict(
          "You have an unpaid cancellation fee. Contact support to settle it, then delete your account.",
          "ACCOUNT_DELETION_BLOCKED",
          { reason: "CANCELLATION_FEE_DUE" },
        );
      return;
    }

    const [owed, clawback] = await Promise.all([
      this.earnings
        .exists({
          driverUserId: userId,
          status: { $in: [EarningStatus.PENDING, EarningStatus.AVAILABLE] },
        })
        .exec(),
      this.adjustments
        .exists({ driverUserId: userId, status: AdjustmentStatus.OUTSTANDING })
        .exec(),
    ]);
    if (owed || clawback)
      throw apiConflict(
        "Your earnings are not fully settled yet. Contact support to receive your payout, then delete your account.",
        "ACCOUNT_DELETION_BLOCKED",
        { reason: "EARNINGS_UNSETTLED" },
      );
  }

  /** Licence details, document files and vehicle details of a driver. */
  private async eraseDriver(userId: Types.ObjectId): Promise<void> {
    const driver = await this.drivers
      .findOne({ userId })
      .select("_id")
      .lean()
      .exec();
    if (!driver) return;
    const driverId = driver._id;

    const vehicles = await this.vehicles
      .find({ driverId })
      .select("_id vehicleImage")
      .lean()
      .exec();
    const vehicleIds = vehicles.map((vehicle) => vehicle._id);

    const [driverDocs, vehicleDocs, requests] = await Promise.all([
      this.driverDocuments.find({ driverId }).select("filePath").lean().exec(),
      this.vehicleDocuments
        .find({ vehicleId: { $in: vehicleIds } })
        .select("filePath")
        .lean()
        .exec(),
      this.changeRequests.find({ driverId }).select("filePath").lean().exec(),
    ]);
    const files = [
      ...driverDocs.map((doc) => doc.filePath),
      ...vehicleDocs.map((doc) => doc.filePath),
      ...requests.map((request) => request.filePath),
      ...vehicles.map((vehicle) => vehicle.vehicleImage),
    ].filter((path): path is string => Boolean(path));

    await Promise.all([
      this.driverDocuments.deleteMany({ driverId }).exec(),
      this.vehicleDocuments
        .deleteMany({ vehicleId: { $in: vehicleIds } })
        .exec(),
      this.changeRequests.deleteMany({ driverId }).exec(),
    ]);
    await Promise.all(files.map((reference) => this.storage.remove(reference)));

    // Registration numbers are released so the vehicle can be registered again.
    for (const vehicle of vehicles)
      await this.vehicles
        .updateOne(
          { _id: vehicle._id },
          {
            $set: {
              isActive: false,
              registrationNumber: `DELETED-${vehicle._id.toHexString()}`,
            },
            $unset: {
              make: 1,
              vehicleModel: 1,
              color: 1,
              manufactureYear: 1,
              vehicleImage: 1,
            },
          },
        )
        .exec();

    await this.drivers
      .updateOne(
        { _id: driverId },
        {
          $set: {
            driverStatus: DriverStatus.SUSPENDED,
            suspensionReason: "Account deleted by the driver",
            suspendedAt: new Date(),
            isOnline: false,
            isAvailable: false,
          },
          $unset: {
            licenseNumber: 1,
            licenseExpiry: 1,
            dateOfBirth: 1,
            address: 1,
            currentLocation: 1,
            locationUpdatedAt: 1,
            activeVehicleId: 1,
            activeVehicleType: 1,
            currentRideId: 1,
          },
        },
      )
      .exec();
  }

  /** The person's identity and everything only they used. */
  private async erasePersonalData(
    userId: Types.ObjectId,
    phone: string,
  ): Promise<void> {
    const photo = await this.profileImages
      .findOne({ userId })
      .select("fileRef")
      .lean()
      .exec();
    await this.storage.remove(photo?.fileRef);
    await Promise.all([
      this.profileImages.deleteMany({ userId }).exec(),
      this.savedPlaces.deleteMany({ userId }).exec(),
      this.emergencyContacts.deleteMany({ userId }).exec(),
      this.notifications.deleteMany({ userId }).exec(),
      this.deviceTokens.deleteMany({ userId }).exec(),
      this.passwordResets.deleteMany({ userId }).exec(),
      this.pendingSignups.deleteMany({ phone }).exec(),
      this.otps.deleteMany({ phone }).exec(),
      this.otpQuotas.deleteMany({ phone }).exec(),
      // Live links to a ride stop working at once.
      this.shareTokens
        .updateMany(
          { customerId: userId, isActive: true },
          { $set: { isActive: false, revokedAt: new Date() } },
        )
        .exec(),
    ]);

    // The phone number is freed (and unique) so the person can sign up again.
    await this.users
      .updateOne(
        { _id: userId },
        {
          $set: {
            phone: `deleted:${userId.toHexString()}`,
            firstName: "Deleted user",
            isPhoneVerified: false,
            isEmailVerified: false,
          },
          $unset: {
            lastName: 1,
            email: 1,
            passwordHash: 1,
            profileImage: 1,
            gender: 1,
            dob: 1,
            statusReason: 1,
            lastLoginAt: 1,
          },
        },
      )
      .exec();
  }
}
