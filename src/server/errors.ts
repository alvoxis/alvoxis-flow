/** Errors raised by server-side authorization. Map them to 403/401 at the HTTP boundary. */
export class ForbiddenError extends Error {
  constructor(message = "Forbidden") {
    super(message);
    this.name = "ForbiddenError";
  }
}

/**
 * The action needs an active subscription and the company's is inactive (read-only mode). A
 * ForbiddenError, so every caller that hides forbidden things keeps doing so; the HTTP boundary
 * maps it to 402 subscription_required.
 */
export class SubscriptionRequiredError extends ForbiddenError {
  constructor() {
    super("An active subscription is required for this action");
    this.name = "SubscriptionRequiredError";
  }
}

export class TwoFactorRequiredError extends Error {
  constructor() {
    super("Two-factor authentication is required for this role");
    this.name = "TwoFactorRequiredError";
  }
}

/** No valid session (or the user is disabled). Map to 401. */
export class UnauthenticatedError extends Error {
  constructor(message = "Authentication required") {
    super(message);
    this.name = "UnauthenticatedError";
  }
}

/**
 * The user has 2FA enabled but this session has not passed a second factor yet (e.g. after a
 * Google sign-in). Only the 2FA challenge and sign-out are allowed. Map to 401.
 */
export class TwoFactorChallengeRequiredError extends Error {
  constructor() {
    super("Complete the two-factor challenge for this session");
    this.name = "TwoFactorChallengeRequiredError";
  }
}
