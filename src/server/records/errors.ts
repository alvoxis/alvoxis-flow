import { type ValidationIssue } from "@/modules/documents/domain/validation";

/**
 * Errors shared by the company record modules (customers and suppliers, products, inventory,
 * production, payroll). `apiError` maps them to stable responses: 404 not_found, 409
 * version_conflict, 409 `<code>` (e.g. code_taken), 409 invalid_state and 422
 * validation_failed with issues. Messages never include record data.
 */
export class RecordNotFoundError extends Error {
  constructor() {
    super("Record not found");
    this.name = "RecordNotFoundError";
  }
}

/** Optimistic concurrency: the record changed since the caller loaded it. */
export class RecordVersionConflictError extends Error {
  constructor() {
    super("The record was changed by someone else; reload and try again");
    this.name = "RecordVersionConflictError";
  }
}

/** A unique value (code, SKU, registration number…) is already used; `code` names the case. */
export class RecordTakenError extends Error {
  constructor(public readonly code: string) {
    super(`Already taken: ${code}`);
    this.name = "RecordTakenError";
  }
}

/** The record is in a state that does not allow the action (e.g. a posted payroll run). */
export class RecordStateError extends Error {
  constructor(public readonly code: string) {
    super(`Invalid state: ${code}`);
    this.name = "RecordStateError";
  }
}

export class RecordValidationError extends Error {
  constructor(public readonly issues: ValidationIssue[]) {
    super(`Record is not valid: ${issues.map((i) => i.code).join(", ")}`);
    this.name = "RecordValidationError";
  }
}
