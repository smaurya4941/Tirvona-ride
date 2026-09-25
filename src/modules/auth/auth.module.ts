import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { JwtModule } from "@nestjs/jwt";
import { MongooseModule } from "@nestjs/mongoose";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { DriversModule } from "../drivers/drivers.module";
import { UsersModule } from "../users/users.module";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { OtpService } from "./otp.service";
import {
  OtpVerification,
  OtpVerificationSchema,
} from "./schemas/otp-verification.schema";
import { UserSession, UserSessionSchema } from "./schemas/user-session.schema";
import { TokenService } from "./token.service";

@Module({
  imports: [
    // Secrets are supplied per sign/verify call (access vs refresh use
    // different ones) — see TokenService and JwtAuthGuard.
    JwtModule.register({}),
    MongooseModule.forFeature([
      { name: UserSession.name, schema: UserSessionSchema },
      { name: OtpVerification.name, schema: OtpVerificationSchema },
    ]),
    UsersModule,
    DriversModule,
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    TokenService,
    OtpService,
    // Applied to every route in the app; individual routes opt out with
    // @Public() or restrict with @Roles(). RolesGuard must run after
    // JwtAuthGuard (relies on request.user), which array order guarantees.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  exports: [TokenService],
})
export class AuthModule {}
