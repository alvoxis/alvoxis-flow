import { type ValidationIssue } from "../domain/validation";

export class DocumentNotFoundError extends Error {
  constructor() {
    super("Document not found");
    this.name = "DocumentNotFoundError";
  }
}

export class DocumentValidationError extends Error {
  constructor(public readonly issues: ValidationIssue[]) {
    super(
      `Document is not valid: ${issues
        .filter((i) => i.severity === "error")
        .map((i) => i.code)
        .join(", ")}`,
    );
    this.name = "DocumentValidationError";
  }
}

export class DocumentStateError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DocumentStateError";
  }
}

/** Optimistic concurrency: the draft changed since the caller loaded it. */
export class DocumentVersionConflictError extends Error {
  constructor() {
    super("The document was changed by someone else; reload and try again");
    this.name = "DocumentVersionConflictError";
  }
}

export class TaxCategoryNotFoundError extends Error {
  constructor() {
    super("Tax category not found");
    this.name = "TaxCategoryNotFoundError";
  }
}

/** Codes are unique per company, archived categories included. */
export class TaxCategoryCodeTakenError extends Error {
  constructor() {
    super("A tax category with this code already exists");
    this.name = "TaxCategoryCodeTakenError";
  }
}

/** Optimistic concurrency: the category changed since the caller loaded it. */
export class TaxCategoryVersionConflictError extends Error {
  constructor() {
    super("The tax category was changed by someone else; reload and try again");
    this.name = "TaxCategoryVersionConflictError";
  }
}
