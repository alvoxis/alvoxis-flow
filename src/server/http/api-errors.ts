import { NextResponse } from "next/server";
import { ZodError } from "zod";
import {
  DocumentNotFoundError,
  DocumentStateError,
  DocumentValidationError,
  DocumentVersionConflictError,
} from "@/modules/documents/server/errors";
import {
  ForbiddenError,
  TwoFactorChallengeRequiredError,
  TwoFactorRequiredError,
  UnauthenticatedError,
} from "@/server/errors";

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
  if (err instanceof ForbiddenError) return json(403, "forbidden");
  if (err instanceof DocumentNotFoundError) return json(404, "not_found");
  if (err instanceof DocumentVersionConflictError) return json(409, "version_conflict");
  if (err instanceof DocumentStateError) return json(409, "invalid_state", { code: err.code });
  if (err instanceof DocumentValidationError)
    return json(422, "validation_failed", { issues: err.issues });
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
