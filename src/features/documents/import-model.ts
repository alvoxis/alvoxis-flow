import { type AppLocale } from "@/i18n/config";
import { type CurrencyCode, SUPPORTED_CURRENCIES } from "@/lib/money";
import { type ImportReview } from "@/modules/documents/import/review";
import { type ImportDecisions } from "@/modules/documents/import/to-draft";
import { type ApiIssue } from "./editor-model";

/**
 * Client-side glue for importing a PDF: the review form's state, the decisions sent to the server
 * and the answers it gives. No business rules: the server reads the file again, checks that every
 * finding was acknowledged and validates the draft; the checks here only catch obvious gaps early.
 */

/**
 * Largest file accepted by the upload. Below the 4.5 MB request-body limit of serverless hosting
 * (Vercel), so a file is refused with a clear message instead of a platform error. The import
 * service itself allows up to MAX_IMPORT_BYTES.
 */
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

export const IMPORT_DOCUMENT_TYPES = ["invoice", "proforma", "delivery_note"] as const;
type ImportType = (typeof IMPORT_DOCUMENT_TYPES)[number];

export interface ImportLine {
  description: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  /** Printed line total, shown for comparison only. */
  total: string | null;
  flags: string[];
}

export interface ImportForm {
  type: ImportType;
  language: AppLocale;
  currency: CurrencyCode | "";
  issueDate: string;
  dueDate: string;
  buyerName: string;
  buyerRegistrationNumber: string;
  buyerVatNumber: string;
  buyerReference: string;
  paymentTerms: string;
  defaultTaxCategoryId: string;
  bankAccountId: string;
  lines: ImportLine[];
  /** Codes of the findings the user has checked. */
  acknowledged: string[];
  acknowledgedDuplicates: boolean;
}

export type ImportProblem =
  "currency" | "issueDate" | "buyerName" | "taxCategory" | "lines" | "findings" | "duplicates";

/** Findings that must be checked before a draft can be created (warnings and errors). */
export function findingsToCheck(review: ImportReview): string[] {
  return [...new Set(review.flags.filter((f) => f.severity !== "info").map((f) => f.code))];
}

/** Whether a found duplicate is strong enough to require an explicit confirmation. */
export function needsDuplicateConfirmation(review: ImportReview): boolean {
  return review.duplicates.some((d) => d.strength !== "possible");
}

/** The review form prefilled with what was read from the file (never with guesses). */
export function initialImportForm(
  review: ImportReview,
  defaults: { language: AppLocale; bankAccountId: string },
): ImportForm {
  const buyerId = (kind: "registration" | "vat") =>
    review.identifiers.find((i) => i.side === "buyer" && i.kind === kind)?.value ?? "";
  const type = review.documentType.value;
  const currency = review.currency.value;
  return {
    type: type && type !== "credit_note" ? type : "invoice",
    language: defaults.language,
    currency:
      currency && (SUPPORTED_CURRENCIES as readonly string[]).includes(currency) ? currency : "",
    issueDate: review.issueDate.value ?? "",
    dueDate: review.dueDate.value ?? "",
    buyerName: review.buyer.name.value ?? "",
    buyerRegistrationNumber: buyerId("registration"),
    buyerVatNumber: buyerId("vat"),
    buyerReference: review.buyerReference.value ?? "",
    paymentTerms: review.paymentTerms.value ?? "",
    defaultTaxCategoryId: "",
    bankAccountId: defaults.bankAccountId,
    lines: review.lines.map((l) => ({
      description: l.description,
      quantity: l.quantity ?? "",
      unit: l.unit ?? "",
      unitPrice: l.unitPrice ?? "",
      total: l.total,
      flags: l.flags,
    })),
    acknowledged: [],
    acknowledgedDuplicates: false,
  };
}

const DECIMAL = /^\d{1,14}(\.\d{1,4})?$/;
const normalizeNumber = (v: string) => v.trim().replace(",", ".");

/** Obvious gaps, in form order; empty when the request may be sent. */
export function importFormProblems(form: ImportForm, review: ImportReview): ImportProblem[] {
  const problems: ImportProblem[] = [];
  if (!form.currency) problems.push("currency");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.issueDate)) problems.push("issueDate");
  if (!form.buyerName.trim()) problems.push("buyerName");
  if (!form.defaultTaxCategoryId) problems.push("taxCategory");
  if (
    form.lines.length === 0 ||
    form.lines.some(
      (l) =>
        !l.description.trim() ||
        !DECIMAL.test(normalizeNumber(l.quantity)) ||
        Number(normalizeNumber(l.quantity)) === 0 ||
        !DECIMAL.test(normalizeNumber(l.unitPrice)),
    )
  )
    problems.push("lines");
  if (findingsToCheck(review).some((code) => !form.acknowledged.includes(code)))
    problems.push("findings");
  if (needsDuplicateConfirmation(review) && !form.acknowledgedDuplicates)
    problems.push("duplicates");
  return problems;
}

/**
 * The decisions sent with the file. The seller is always the company itself (the server takes it
 * from the company profile), so only its name is sent to satisfy the shape.
 */
export function toImportDecisions(form: ImportForm, companyName: string): ImportDecisions {
  const opt = (v: string) => (v.trim() ? v.trim() : undefined);
  return {
    type: form.type,
    language: form.language,
    currency: form.currency as CurrencyCode,
    issueDate: form.issueDate,
    ...(opt(form.dueDate) ? { dueDate: form.dueDate } : {}),
    seller: { name: companyName },
    buyer: {
      name: form.buyerName.trim(),
      ...(opt(form.buyerRegistrationNumber)
        ? { registrationNumber: opt(form.buyerRegistrationNumber) }
        : {}),
      ...(opt(form.buyerVatNumber) ? { vatNumber: opt(form.buyerVatNumber) } : {}),
    },
    ...(form.bankAccountId ? { bankAccountId: form.bankAccountId } : {}),
    ...(opt(form.buyerReference) ? { buyerReference: opt(form.buyerReference) } : {}),
    ...(opt(form.paymentTerms) ? { paymentTerms: opt(form.paymentTerms) } : {}),
    defaultTaxCategoryId: form.defaultTaxCategoryId,
    lines: form.lines.map((l) => ({
      description: l.description.trim(),
      quantity: normalizeNumber(l.quantity),
      ...(l.unit.trim() ? { unit: l.unit.trim() } : {}),
      unitPrice: normalizeNumber(l.unitPrice),
    })),
    acknowledgedFlags: [...form.acknowledged, ...form.lines.flatMap((l) => l.flags)],
    ...(form.acknowledgedDuplicates ? { acknowledgedDuplicates: true } : {}),
  };
}

export type ImportOutcome =
  | { kind: "review"; review: ImportReview }
  | { kind: "created"; documentId: string }
  | { kind: "invalid"; issues: ApiIssue[] }
  | { kind: "file"; code: string }
  | { kind: "tooLarge" }
  | { kind: "twoFactor" }
  | { kind: "forbidden" }
  | { kind: "signedOut" }
  | { kind: "error" };

/** Classifies an answer of the import endpoints by its documented status and error code. */
export function interpretImportResponse(status: number, body: unknown): ImportOutcome {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (status === 200 && b.review && typeof b.review === "object")
    return { kind: "review", review: b.review as ImportReview };
  if (status === 201 && b.document && typeof b.document === "object")
    return { kind: "created", documentId: String((b.document as { id: unknown }).id) };
  if (status === 413) return { kind: "tooLarge" };
  if (status === 422 && Array.isArray(b.issues))
    return { kind: "invalid", issues: b.issues as ApiIssue[] };
  if (status === 409 && typeof b.code === "string" && b.code.startsWith("import.file."))
    return { kind: "file", code: b.code };
  if (status === 401 && b.error === "two_factor_challenge_required") return { kind: "twoFactor" };
  if (status === 401) return { kind: "signedOut" };
  if (status === 403 && b.error === "two_factor_enrollment_required") return { kind: "twoFactor" };
  if (status === 403) return { kind: "forbidden" };
  return { kind: "error" };
}
