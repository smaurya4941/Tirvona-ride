import { Injectable, Logger } from "@nestjs/common";
import { apiNotFound } from "../../common/exceptions/api.exception";
import { maskPhone } from "../../common/phone/phone-number";
import { UserRole } from "../../common/types/user-role.enum";
import type { UserDocument } from "../users/schemas/user.schema";
import { UsersService } from "../users/users.service";
import type { AuthSession } from "./auth.service";
import { AuthService } from "./auth.service";
import { toOtpChallengeView } from "./otp-challenge.view";
import type { OtpChallengeView } from "./otp-challenge.view";
import { OtpService } from "./otp.service";
import { OtpPurpose } from "./schemas/otp-verification.schema";
import type { DeviceMetadata } from "./token.service";

/**
 * Passwordless sign-in over WhatsApp, next to (not instead of) password login:
 *
 *   request ─► WhatsApp code (purpose LOGIN) ─► verify ─► the same AuthSession as POST /auth/login
 *
 * Phone + code is enough here. Signup needs a verificationId because the
 * form carries user-supplied details (a password) that a stranger could
 * attach to your number; a login carries nothing to hijack.
 *
 * Whether a number has an account is not hidden: sign-up and forgot
 * password already answer that, so a vague "if it's registered we sent a
 * code" would only leave unregistered users waiting. Admin accounts stay
 * password-only (the admin panel has its own login) and look like unknown
 * numbers. LOGIN codes have their own send budget, separate from signup and
 * password reset (OtpService keys quotas per purpose).
 */
@Injectable()
export class LoginOtpService {
  private readonly logger = new Logger(LoginOtpService.name);

  constructor(
    private readonly users: UsersService,
    private readonly otp: OtpService,
    private readonly auth: AuthService,
  ) {}

  /**
   * POST /auth/login/otp/request — sends a sign-in code. Asking again inside
   * the resend cooldown keeps the code already on its way (codeSent=false);
   * after it, a new code is sent and every earlier one stops working, so this
   * is also the resend.
   */
  async requestCode(phone: string): Promise<OtpChallengeView> {
    await this.signInAccount(phone);
    const active = await this.otp.activeChallenge(phone, OtpPurpose.LOGIN);
    const challenge =
      active && active.resendAvailableInSeconds > 0
        ? active
        : await this.otp.issue(phone, OtpPurpose.LOGIN);
    if (challenge.codeSent)
      this.logger.log(`Login code sent to ${maskPhone(phone)}`);
    return toOtpChallengeView(phone, challenge);
  }

  /**
   * POST /auth/login/otp/verify — consumes the code and signs the user in.
   * The account is checked again before the code is spent, so a block that
   * landed after the request still wins.
   */
  async verify(
    phone: string,
    code: string,
    device: DeviceMetadata,
  ): Promise<AuthSession> {
    const user = await this.signInAccount(phone);
    await this.otp.verify(phone, OtpPurpose.LOGIN, code);

    // Receiving the code on this number proves it (accounts created before signup OTP).
    if (!user.isPhoneVerified)
      await this.users.markPhoneVerified(user._id.toString());
    this.logger.log(`Signed in with a WhatsApp code: ${maskPhone(phone)}`);
    return this.auth.completeSignIn(user, device);
  }

  /** The account a code may be sent to; unknown and admin numbers get the same answer. */
  private async signInAccount(phone: string): Promise<UserDocument> {
    const user = await this.users.findByPhone(phone);
    if (!user || user.role === UserRole.ADMIN)
      throw apiNotFound(
        "No Tirvona Rides account uses this mobile number. Check the number or create an account.",
        "ACCOUNT_NOT_FOUND",
      );
    this.auth.assertCanSignIn(user);
    return user;
  }
}
