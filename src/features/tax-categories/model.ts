import { type ApiIssue } from "@/features/documents/editor-model";
import { TAX_TREATMENT_KINDS, type TaxTreatmentKind } from "@/modules/documents/domain/types";

/**
 * Client-side glue for the tax-category catalog page. No tax rules here: consistency checks,
 * permissions and uniqueness are decided by the server; this module only classifies answers.
 */

export const KINDS = TAX_TREATMENT_KINDS;

/** A category as the catalog API returns it. */
export interface TaxCategoryItem {
  id: string;
  code: string;
  kind: TaxTreatmentKind;
  ratePercent: string;
  label: string;
  note: string | null;
  archived: boolean;
  version: number;
}

export type CategoryOutcome =
  | { kind: "ok"; taxCategory: TaxCategoryItem; issues: ApiIssue[] }
  | { kind: "invalid"; issues: ApiIssue[] }
  | { kind: "codeTaken" }
  | { kind: "conflict" }
  | { kind: "signedOut" }
  | { kind: "twoFactor" }
  | { kind: "forbidden" }
  | { kind: "notFound" }
  | { kind: "error" };

/** Classifies a catalog API response by its documented status and error code. */
export function interpretCategoryResponse(status: number, body: unknown): CategoryOutcome {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (status >= 200 && status < 300 && b.taxCategory && typeof b.taxCategory === "object")
    return {
      kind: "ok",
      taxCategory: b.taxCategory as TaxCategoryItem,
      issues: Array.isArray(b.issues) ? (b.issues as ApiIssue[]) : [],
    };
  if (status === 422 && b.error === "validation_failed" && Array.isArray(b.issues))
    return { kind: "invalid", issues: b.issues as ApiIssue[] };
  if (status === 409 && b.error === "code_taken") return { kind: "codeTaken" };
  if (status === 409 && b.error === "version_conflict") return { kind: "conflict" };
  if (status === 401 && b.error === "two_factor_challenge_required") return { kind: "twoFactor" };
  if (status === 401) return { kind: "signedOut" };
  if (status === 403 && b.error === "two_factor_enrollment_required") return { kind: "twoFactor" };
  if (status === 403) return { kind: "forbidden" };
  if (status === 404) return { kind: "notFound" };
  return { kind: "error" };
}

/** Form fields of a new category (strings as typed; the server validates). */
export interface CategoryDraft {
  code: string;
  kind: TaxTreatmentKind;
  ratePercent: string;
  label: string;
  note: string;
}

/** POST body: trimmed values, empty note omitted. */
export function toCreateBody(d: CategoryDraft) {
  const note = d.note.trim();
  return {
    code: d.code.trim(),
    kind: d.kind,
    ratePercent: d.ratePercent.trim().replace(",", "."),
    label: d.label.trim(),
    ...(note ? { note } : {}),
  };
}

/** Which form field an issue points at (`ratePercent`, `kind`, `note`, `code`, `label`, or ""). */
export function fieldOfIssue(path: string): string {
  return path.split(".")[0] ?? "";
}
