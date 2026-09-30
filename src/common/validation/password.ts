import { applyDecorators } from "@nestjs/common";
import { IsString, Length, Matches } from "class-validator";

/** At least 8 characters with a lowercase and an uppercase letter, a digit and a symbol. */
export const STRONG_PASSWORD = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^\da-zA-Z]).{8,}$/;

/**
 * The password policy every "choose a password" field shares (sign-up,
 * change password, reset password), so the apps see one rule and one message.
 */
export const IsStrongPassword = (field: string): PropertyDecorator =>
  applyDecorators(
    IsString(),
    Length(8, 128),
    Matches(STRONG_PASSWORD, {
      message: `${field} must contain an uppercase letter, a lowercase letter, a number and a symbol`,
    }),
  );
