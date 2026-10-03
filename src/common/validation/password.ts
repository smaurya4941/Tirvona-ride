import { applyDecorators } from "@nestjs/common";
import { IsString, Length } from "class-validator";

export const PASSWORD_MIN_LENGTH = 6;
export const PASSWORD_MAX_LENGTH = 128;

/**
 * The password policy every "choose a password" field shares (sign-up,
 * change password, reset password), so the apps see one rule and one message.
 * Only the length is checked: any characters are allowed, with no required
 * digit, symbol or letter case.
 */
export const IsStrongPassword = (field: string): PropertyDecorator =>
  applyDecorators(
    IsString(),
    Length(PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH, {
      message: `${field} must be between ${PASSWORD_MIN_LENGTH} and ${PASSWORD_MAX_LENGTH} characters`,
    }),
  );
