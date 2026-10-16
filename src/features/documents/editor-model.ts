import {
  type DocumentDraft,
  type DocumentLine,
  type PartySnapshot,
} from "@/modules/documents/domain/types";

/**
 * Client-side glue between the draft editor and the document API. Deliberately free of business
 * rules: validation, totals, numbering and access checks all happen on the server; this module
 * only shapes the request body and classifies the response.
 */

/** Issue as returned by the API (`validateDocument` findings or `input.*` shape errors). */
export interface ApiIssue {
  code: string;
  severity: "error" | "warning";
  path: string;
}

/** The subset of the API document the UI reads. */
export interface ApiDocument {
  id: string;
  status: "draft" | "issued";
  number: string | null;
  version: number;
  draft: DocumentDraft;
  totals: { currency: string; netTotal: string; taxTotal: string; grossTotal: string } | null;
  issues: ApiIssue[];
}

export type ApiOutcome =
  | { kind: "ok"; document: ApiDocument }
  | { kind: "invalid"; issues: ApiIssue[] }
  | { kind: "conflict" }
  | { kind: "notDraft" }
  | { kind: "state"; code: string }
  | { kind: "signedOut" }
  | { kind: "twoFactor" }
  | { kind: "forbidden" }
  | { kind: "notFound" }
  | { kind: "error" };

/** Classifies an API response by its documented status and error code. */
export function interpretResponse(status: number, body: unknown): ApiOutcome {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (status >= 200 && status < 300 && b.document && typeof b.document === "object")
    return { kind: "ok", document: b.document as ApiDocument };
  const error = b.error;
  if (status === 422 && error === "validation_failed" && Array.isArray(b.issues))
    return { kind: "invalid", issues: b.issues as ApiIssue[] };
  if (status === 409 && error === "version_conflict") return { kind: "conflict" };
  if (status === 409 && error === "invalid_state") {
    const code = typeof b.code === "string" ? b.code : "";
    return code === "document.notDraft" || code === "document.alreadyIssued"
      ? { kind: "notDraft" }
      : { kind: "state", code };
  }
  if (status === 401 && error === "two_factor_challenge_required") return { kind: "twoFactor" };
  if (status === 401) return { kind: "signedOut" };
  if (status === 403 && error === "two_factor_enrollment_required") return { kind: "twoFactor" };
  if (status === 403) return { kind: "forbidden" };
  if (status === 404) return { kind: "notFound" };
  return { kind: "error" };
}

/** `lines[2].unitPrice` (validation) and `lines.2.unitPrice` (shape errors) → 2. */
export function lineIndexOf(path: string): number | null {
  const m = /^lines(?:\[(\d+)\]|\.(\d+))/.exec(path);
  return m ? Number(m[1] ?? m[2]) : null;
}

/** Path without line indexes: `lines[2].taxCategory.kind` → `lines.taxCategory.kind`. */
export function fieldOf(path: string): string {
  return path.replace(/\[\d+\]|\.\d+(?=\.|$)/g, "");
}

/** Whether an error-severity issue points at `field` (optionally of line `line`). */
export function hasErrorAt(issues: readonly ApiIssue[], field: string, line?: number): boolean {
  return issues.some(
    (i) =>
      i.severity === "error" &&
      (line === undefined || lineIndexOf(i.path) === line) &&
      (fieldOf(i.path) === field || fieldOf(i.path).startsWith(`${field}.`)),
  );
}

const blank = (v: string | undefined) => (v === undefined || v.trim() === "" ? undefined : v);

function cleanParty(p: PartySnapshot): PartySnapshot {
  const address = p.address
    ? {
        ...p.address,
        lines: p.address.lines.filter((l) => l.trim() !== ""),
        postalCode: blank(p.address.postalCode),
        city: blank(p.address.city),
        countryCode: blank(p.address.countryCode)?.toUpperCase(),
      }
    : undefined;
  const hasAddress =
    address && (address.lines.length || address.postalCode || address.city || address.countryCode);
  return {
    ...p,
    registrationNumber: blank(p.registrationNumber),
    vatNumber: blank(p.vatNumber),
    email: blank(p.email),
    phone: blank(p.phone),
    contactName: blank(p.contactName),
    address: hasAddress ? address : undefined,
  };
}

/** Lines refer to a company category by id; the server builds the tax snapshot itself. */
function cleanLine({ sourceLineId: _s, taxCategory: _snapshot, ...l }: DocumentLine) {
  return {
    ...l,
    taxCategoryId: l.taxCategoryId ?? null,
    unit: blank(l.unit),
    discountPercent: blank(l.discountPercent),
    // An empty price is "no price", so the server reports it as a missing price, not a format error.
    unitPrice: blank(l.unitPrice ?? undefined) ?? null,
  };
}

/**
 * The PATCH `draft` body: the edited draft with empty optional fields omitted. Relations and the
 * seller are not editable; the server ignores them (the seller comes from the company profile).
 */
export function toDraftInput(draft: DocumentDraft) {
  const { relation: _relation, ...rest } = draft;
  return {
    ...rest,
    dueDate: blank(draft.dueDate),
    supplyDate: blank(draft.supplyDate),
    validUntil: blank(draft.validUntil),
    buyerReference: blank(draft.buyerReference),
    paymentTerms: blank(draft.paymentTerms),
    notes: blank(draft.notes),
    footer: blank(draft.footer),
    buyer: cleanParty(draft.buyer),
    deliverTo: draft.deliverTo ? cleanParty(draft.deliverTo) : undefined,
    lines: draft.lines.map(cleanLine),
  };
}

/**
 * A new empty line for an unpriced document (delivery note). It never gets a tax category: the
 * API offers no category source yet, so priced documents cannot add lines in the editor.
 */
export function newLine(id: string): DocumentLine {
  return { id, kind: "item", description: "", quantity: "1", unitPrice: null, taxCategory: null };
}
