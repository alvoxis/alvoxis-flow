import Decimal from "decimal.js";
import { type documentLines, type documents } from "@/server/db/schema";
import { type DocumentDraft, type DocumentLine } from "../domain/types";

type DocumentRow = typeof documents.$inferSelect;
type LineRow = typeof documentLines.$inferSelect;

/** Strips NUMERIC padding ("10.0000" → "10") so snapshots and hashes are stable. */
export function normalizeDecimal(value: string): string {
  return new Decimal(value).toFixed();
}

const opt = <T>(v: T | null): T | undefined => (v === null ? undefined : v);

export function rowToLine(row: LineRow): DocumentLine {
  const line: DocumentLine = {
    id: row.id,
    kind: row.kind,
    description: row.description,
    quantity: normalizeDecimal(row.quantity),
    unit: opt(row.unit),
    unitPrice: row.unitPrice === null ? null : normalizeDecimal(row.unitPrice),
    discountPercent:
      row.discountPercent === null ? undefined : normalizeDecimal(row.discountPercent),
    taxCategory: row.taxCategory,
    weightKg: row.weightKg === null ? undefined : normalizeDecimal(row.weightKg),
    sourceLineId: opt(row.sourceLineId),
  };
  return Object.fromEntries(
    Object.entries(line).filter(([, v]) => v !== undefined),
  ) as DocumentLine;
}

export function rowToDraft(
  row: DocumentRow,
  lines: LineRow[],
  relatedNumber?: { number: string; issueDate: string },
): DocumentDraft {
  const draft: DocumentDraft = {
    type: row.type,
    language: row.language,
    currency: row.currency,
    issueDate: row.issueDate,
    dueDate: opt(row.dueDate),
    supplyDate: opt(row.supplyDate),
    validUntil: opt(row.validUntil),
    seller: row.seller,
    buyer: row.buyer,
    deliverTo: opt(row.deliverTo),
    bankAccounts: row.bankAccounts,
    buyerReference: opt(row.buyerReference),
    paymentTerms: opt(row.paymentTerms),
    notes: opt(row.notes),
    footer: opt(row.footer),
    lines: [...lines].sort((a, b) => a.position - b.position).map(rowToLine),
    exchangeRate: opt(row.exchangeRate),
    relation:
      row.relationKind && row.relatedDocumentId && relatedNumber
        ? {
            kind: row.relationKind,
            documentId: row.relatedDocumentId,
            documentNumber: relatedNumber.number,
            issueDate: relatedNumber.issueDate,
          }
        : undefined,
  };
  return Object.fromEntries(
    Object.entries(draft).filter(([, v]) => v !== undefined),
  ) as DocumentDraft;
}

export function draftToRowValues(draft: DocumentDraft) {
  return {
    type: draft.type,
    language: draft.language,
    currency: draft.currency,
    issueDate: draft.issueDate,
    dueDate: draft.dueDate ?? null,
    supplyDate: draft.supplyDate ?? null,
    validUntil: draft.validUntil ?? null,
    seller: draft.seller,
    buyer: draft.buyer,
    deliverTo: draft.deliverTo ?? null,
    bankAccounts: draft.bankAccounts,
    buyerReference: draft.buyerReference ?? null,
    paymentTerms: draft.paymentTerms ?? null,
    notes: draft.notes ?? null,
    footer: draft.footer ?? null,
    exchangeRate: draft.exchangeRate ?? null,
    relationKind: draft.relation?.kind ?? null,
    relatedDocumentId: draft.relation?.documentId ?? null,
  };
}

export function lineToRowValues(
  line: DocumentLine,
  position: number,
  companyId: string,
  documentId: string,
) {
  return {
    companyId,
    documentId,
    position,
    kind: line.kind,
    description: line.description,
    quantity: line.quantity,
    unit: line.unit ?? null,
    unitPrice: line.unitPrice,
    discountPercent: line.discountPercent ?? null,
    taxCategory: line.taxCategory,
    weightKg: line.weightKg ?? null,
    sourceLineId: line.sourceLineId ?? null,
  };
}
