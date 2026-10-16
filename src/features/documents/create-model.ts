import { type AppLocale } from "@/i18n/config";
import { type CurrencyCode } from "@/lib/money";

/**
 * Client-side glue for creating and deleting drafts through the existing document API. No
 * business rules: the server checks access, validates the input and fills in the seller.
 */

/** Types offered for a new draft. Credit notes are created from an issued invoice instead. */
export const NEW_DOCUMENT_TYPES = ["invoice", "proforma", "delivery_note"] as const;
export type NewDocumentType = (typeof NEW_DOCUMENT_TYPES)[number];

export interface NewDocumentForm {
  type: NewDocumentType;
  language: AppLocale;
  /** No default: the user must choose explicitly. */
  currency: CurrencyCode | "";
  issueDate: string;
  buyerName: string;
  /** Company bank account printed on the document ("" = none). Not offered for delivery notes. */
  bankAccountId?: string;
}

/**
 * Today's calendar date in the browser's own time zone as YYYY-MM-DD. Uses local date parts on
 * purpose: `toISOString()` would give the UTC date, which is a different day near midnight.
 */
export function localToday(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * Minimal POST body for a new draft. No seller (the server takes it from the company profile),
 * no lines (lines and their tax categories are chosen in the editor) and no bank details: only
 * the chosen account's id, from which the server copies the details.
 */
export function toCreateDraftBody(form: NewDocumentForm) {
  const bankAccountId = form.type !== "delivery_note" ? form.bankAccountId : undefined;
  return {
    type: form.type,
    language: form.language,
    currency: form.currency,
    issueDate: form.issueDate,
    buyer: { name: form.buyerName.trim() },
    ...(bankAccountId ? { bankAccountId } : {}),
    lines: [],
  };
}

export type DeleteOutcome =
  | { kind: "deleted" }
  | { kind: "notDraft" }
  | { kind: "notFound" }
  | { kind: "forbidden" }
  | { kind: "twoFactor" }
  | { kind: "signedOut" }
  | { kind: "error" };

/** Classifies a DELETE …/documents/{id} response by its documented status and error code. */
export function interpretDeleteResponse(status: number, body: unknown): DeleteOutcome {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (status === 200 && b.deleted === true) return { kind: "deleted" };
  if (status === 409 && b.error === "invalid_state") return { kind: "notDraft" };
  if (status === 404) return { kind: "notFound" };
  if (status === 401 && b.error === "two_factor_challenge_required") return { kind: "twoFactor" };
  if (status === 401) return { kind: "signedOut" };
  if (status === 403 && b.error === "two_factor_enrollment_required") return { kind: "twoFactor" };
  if (status === 403) return { kind: "forbidden" };
  return { kind: "error" };
}
