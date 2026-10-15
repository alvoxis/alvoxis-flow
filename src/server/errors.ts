/** Errors raised by server-side authorization. Map them to 403/401 at the HTTP boundary. */
export class ForbiddenError extends Error {
  constructor(message = "Forbidden") {
    super(message);
    this.name = "ForbiddenError";
  }
}

export class TwoFactorRequiredError extends Error {
  constructor() {
    super("Two-factor authentication is required for this role");
    this.name = "TwoFactorRequiredError";
  }
}
