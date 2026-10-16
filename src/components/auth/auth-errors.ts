/** Maps auth library / app error codes to translation keys in `auth.errors`. Unknown → generic. */
export type AuthErrorKey =
  | "invalidCredentials"
  | "emailNotVerified"
  | "passwordTooShort"
  | "passwordTooLong"
  | "invalidEmail"
  | "invalidToken"
  | "invalidCode"
  | "codeUsed"
  | "tooManyRequests"
  | "locked"
  | "requiredForRole"
  | "invalidPassword"
  | "generic";

export function authErrorKey(
  error: { code?: string; status?: number } | null | undefined,
): AuthErrorKey {
  if (!error) return "generic";
  if (error.status === 429) return "tooManyRequests";
  switch (error.code) {
    case "INVALID_EMAIL_OR_PASSWORD":
    case "USER_NOT_FOUND":
      return "invalidCredentials";
    case "EMAIL_NOT_VERIFIED":
      return "emailNotVerified";
    case "PASSWORD_TOO_SHORT":
      return "passwordTooShort";
    case "PASSWORD_TOO_LONG":
      return "passwordTooLong";
    case "INVALID_EMAIL":
      return "invalidEmail";
    case "INVALID_TOKEN":
    case "TOKEN_EXPIRED":
      return "invalidToken";
    case "INVALID_CODE":
    case "INVALID_BACKUP_CODE":
    case "INVALID_TWO_FACTOR_COOKIE":
      return "invalidCode";
    case "CODE_ALREADY_USED":
      return "codeUsed";
    case "TOO_MANY_ATTEMPTS":
    case "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE":
    case "ACCOUNT_TEMPORARILY_LOCKED":
      return "locked";
    case "TWO_FACTOR_REQUIRED_FOR_ROLE":
      return "requiredForRole";
    case "INVALID_PASSWORD":
      return "invalidPassword";
    default:
      return "generic";
  }
}
