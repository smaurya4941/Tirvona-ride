import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { AuthModule } from "../auth/auth.module";
import {
  OtpSendQuota,
  OtpSendQuotaSchema,
} from "../auth/schemas/otp-send-quota.schema";
import {
  OtpVerification,
  OtpVerificationSchema,
} from "../auth/schemas/otp-verification.schema";
import {
  PasswordReset,
  PasswordResetSchema,
} from "../auth/schemas/password-reset.schema";
import {
  PendingSignup,
  PendingSignupSchema,
} from "../auth/schemas/pending-signup.schema";
import {
  Cancellation,
  CancellationSchema,
} from "../cancellations/schemas/cancellation.schemas";
import {
  DriverChangeRequest,
  DriverChangeRequestSchema,
} from "../driver-changes/schemas/driver-change-request.schema";
import {
  DriverDocument,
  DriverDocumentSchema,
} from "../drivers/schemas/driver-document.schema";
import {
  DriverProfile,
  DriverProfileSchema,
} from "../drivers/schemas/driver-profile.schema";
import {
  DriverEarning,
  DriverEarningSchema,
} from "../earnings/schemas/driver-earning.schema";
import {
  DriverEarningAdjustment,
  DriverEarningAdjustmentSchema,
} from "../earnings/schemas/driver-earning-adjustment.schema";
import {
  DeviceToken,
  DeviceTokenSchema,
} from "../notifications/schemas/device-token.schema";
import {
  Notification,
  NotificationSchema,
} from "../notifications/schemas/notification.schema";
import {
  SavedPlace,
  SavedPlaceSchema,
} from "../places/schemas/saved-place.schema";
import { Ride, RideSchema } from "../rides/schemas/ride.schema";
import {
  EmergencyContact,
  EmergencyContactSchema,
} from "../safety/schemas/emergency-contact.schema";
import {
  RideShareToken,
  RideShareTokenSchema,
} from "../safety/schemas/ride-share-token.schema";
import {
  ProfileImage,
  ProfileImageSchema,
} from "../users/schemas/profile-image.schema";
import { UsersModule } from "../users/users.module";
import { Vehicle, VehicleSchema } from "../vehicles/schemas/vehicle.schema";
import {
  VehicleDocument,
  VehicleDocumentSchema,
} from "../vehicles/schemas/vehicle-document.schema";
import { AccountDeletionController } from "./account-deletion.controller";
import { AccountDeletionService } from "./account-deletion.service";

// The service reads and erases other modules' collections directly (models
// injected here, no module imports) so deletion stays one auditable unit and
// no feature module depends on it.
@Module({
  imports: [
    AuthModule,
    UsersModule,
    MongooseModule.forFeature([
      { name: Ride.name, schema: RideSchema },
      { name: Cancellation.name, schema: CancellationSchema },
      { name: DriverProfile.name, schema: DriverProfileSchema },
      { name: DriverDocument.name, schema: DriverDocumentSchema },
      { name: DriverChangeRequest.name, schema: DriverChangeRequestSchema },
      { name: DriverEarning.name, schema: DriverEarningSchema },
      {
        name: DriverEarningAdjustment.name,
        schema: DriverEarningAdjustmentSchema,
      },
      { name: Vehicle.name, schema: VehicleSchema },
      { name: VehicleDocument.name, schema: VehicleDocumentSchema },
      { name: ProfileImage.name, schema: ProfileImageSchema },
      { name: SavedPlace.name, schema: SavedPlaceSchema },
      { name: EmergencyContact.name, schema: EmergencyContactSchema },
      { name: Notification.name, schema: NotificationSchema },
      { name: DeviceToken.name, schema: DeviceTokenSchema },
      { name: RideShareToken.name, schema: RideShareTokenSchema },
      { name: PasswordReset.name, schema: PasswordResetSchema },
      { name: PendingSignup.name, schema: PendingSignupSchema },
      { name: OtpVerification.name, schema: OtpVerificationSchema },
      { name: OtpSendQuota.name, schema: OtpSendQuotaSchema },
    ]),
  ],
  controllers: [AccountDeletionController],
  providers: [AccountDeletionService],
})
export class AccountDeletionModule {}
