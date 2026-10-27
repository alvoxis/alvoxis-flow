import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { AiLimitError } from "@/modules/ai/server/errors";
import { StripeRequestError } from "@/modules/billing/server/stripe-gateway";
import { DocumentRuleError } from "@/modules/documents/domain/derive";
import { ImportDecisionError } from "@/modules/documents/import/to-draft";
import {
  BankAccountIbanTakenError,
  BankAccountNotFoundError,
  BankAccountVersionConflictError,
  DocumentNotFoundError,
  DocumentStateError,
  DocumentValidationError,
  DocumentVersionConflictError,
  TaxCategoryCodeTakenError,
  TaxCategoryNotFoundError,
  TaxCategoryVersionConflictError,
} from "@/modules/documents/server/errors";
import {
  ForbiddenError,
  SubscriptionRequiredError,
  TwoFactorChallengeRequiredError,
  TwoFactorRequiredError,
  UnauthenticatedError,
} from "@/server/errors";
import {
  RecordNotFoundError,
  RecordStateError,
  RecordTakenError,
  RecordValidationError,
  RecordVersionConflictError,
} from "@/server/records/errors";

/** Maps domain/auth errors to stable JSON responses. Messages never include internal detail. */
export function apiError(err: unknown): NextResponse {
  const json = (status: number, code: string, extra: Record<string, unknown> = {}) =>
    NextResponse.json(
      { error: code, ...extra },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  if (err instanceof UnauthenticatedError) return json(401, "unauthenticated");
  if (err instanceof TwoFactorChallengeRequiredError)
    return json(401, "two_factor_challenge_required");
  if (err instanceof TwoFactorRequiredError) return json(403, "two_factor_enrollment_required");
  if (err instanceof SubscriptionRequiredError) return json(402, "subscription_required");
  if (err instanceof ForbiddenError) return json(403, "forbidden");
  if (err instanceof DocumentNotFoundError) return json(404, "not_found");
  if (err instanceof RecordNotFoundError) return json(404, "not_found");
  if (err instanceof StripeRequestError) {
    console.error(`[billing] ${err.message}`);
    return json(502, "payment_provider_error");
  }
  if (err instanceof AiLimitError) return json(429, err.code);
  if (err instanceof RecordVersionConflictError) return json(409, "version_conflict");
  if (err instanceof RecordTakenError) return json(409, err.code);
  if (err instanceof RecordStateError) return json(409, "invalid_state", { code: err.code });
  if (err instanceof RecordValidationError)
    return json(422, "validation_failed", { issues: err.issues });
  if (err instanceof TaxCategoryNotFoundError || err instanceof BankAccountNotFoundError)
    return json(404, "not_found");
  if (
    err instanceof DocumentVersionConflictError ||
    err instanceof TaxCategoryVersionConflictError ||
    err instanceof BankAccountVersionConflictError
  )
    return json(409, "version_conflict");
  if (err instanceof TaxCategoryCodeTakenError) return json(409, "code_taken");
  if (err instanceof BankAccountIbanTakenError) return json(409, "iban_taken");
  if (err instanceof DocumentStateError) return json(409, "invalid_state", { code: err.code });
  if (err instanceof DocumentValidationError)
    return json(422, "validation_failed", { issues: err.issues });
  // Derivation rules (credit notes): a source of the wrong kind is a state conflict; everything
  // else (unknown line, quantity, remaining amount, date) is a finding about the request.
  if (err instanceof DocumentRuleError)
    return err.code.startsWith("source.")
      ? json(409, "invalid_state", { code: err.code })
      : json(422, "validation_failed", {
          issues: [{ code: err.code, severity: "error", path: "" }],
        });
  // An import whose review is incomplete (unacknowledged findings, duplicates, incomplete lines).
  if (err instanceof ImportDecisionError)
    return json(422, "validation_failed", {
      issues: [{ code: err.code, severity: "error", path: "" }],
    });
  if (err instanceof ZodError) return json(400, "invalid_request");
  console.error("[api] unexpected error", err instanceof Error ? err.name : err);
  return json(500, "internal_error");
}

export function ok(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/**
 * Request bodies that fail shape validation (zod) → 422 with field paths, in the same issue
 * format as business-rule findings. Path parameters are checked separately (400).
 */
export function invalidBody(err: unknown): NextResponse {
  if (!(err instanceof ZodError)) return apiError(err);
  const issues = err.issues.map((i) => ({
    code: `input.${i.code}`,
    severity: "error" as const,
    path: i.path.join("."),
  }));
  return ok({ error: "validation_failed", issues }, 422);
}
