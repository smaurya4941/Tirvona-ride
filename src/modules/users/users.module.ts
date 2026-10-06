import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import {
  ProfileImage,
  ProfileImageSchema,
} from "./schemas/profile-image.schema";
import { User, UserSchema } from "./schemas/user.schema";
import { ProfileImagesService } from "./profile-images.service";
import { UsersController } from "./users.controller";
import { UsersService } from "./users.service";
import { AccountStatusService } from "./account-status.service";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: ProfileImage.name, schema: ProfileImageSchema },
    ]),
  ],
  controllers: [UsersController],
  providers: [UsersService, AccountStatusService, ProfileImagesService],
  exports: [UsersService, AccountStatusService, MongooseModule],
})
export class UsersModule {}
