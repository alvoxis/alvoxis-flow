import { type CurrencyCode, type ExchangeRate } from "@/lib/money";
import { type AppLocale } from "@/i18n/config";

/**
 * Document domain model. Pure data — no database or framework types — so it can be used by
 * server services, PDF rendering, import review and tests alike.
 *
 * Monetary and quantity values are decimal STRINGS (never JS numbers).
 */

export const DOCUMENT_TYPES = ["invoice", "proforma", "credit_note", "delivery_note"] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

/**
 * Lifecycle. `issued` documents are immutable; corrections are new documents (credit notes,
 * replacement invoices) linked to the original. Payment state is tracked separately (later stage).
 */
export const DOCUMENT_STATUSES = ["draft", "issued"] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

/**
 * How tax applies to a line. The software never decides this on its own: the company (or its
 * accountant) defines tax categories, and each line carries a snapshot of the category used.
 * - standard:       a positive rate is charged
 * - zero_rated:     taxable at 0%
 * - exempt:         exempt from tax
 * - reverse_charge: tax is accounted for by the buyer
 * - outside_scope:  not subject to this tax (e.g. supply not taxable in this jurisdiction)
 * Which kind applies to a given supply is a legal question that must be answered by the user.
 */
export const TAX_TREATMENT_KINDS = [
  "standard",
  "zero_rated",
  "exempt",
  "reverse_charge",
  "outside_scope",
] as const;
export type TaxTreatmentKind = (typeof TAX_TREATMENT_KINDS)[number];

/** Snapshot of a company-defined tax category, frozen on each line. */
export interface TaxCategorySnapshot {
  /** Company-defined code, e.g. "S21" or "EXEMPT-A". */
  code: string;
  kind: TaxTreatmentKind;
  /** Percentage as decimal string, e.g. "21" or "5.5". Must be "0" unless kind is "standard". */
  ratePercent: string;
  /** Short label printed in the tax summary. */
  label: string;
  /**
   * Explanatory text printed on the document (e.g. the legal basis of an exemption), entered by
   * the user. ALVOXIS Flow does not supply legal wording.
   */
  note?: string;
}

export type LineKind = "item" | "charge";

export interface DocumentLine {
  id: string;
  kind: LineKind;
  description: string;
  /** Signed decimal string. Credit-note lines are negative. Max 4 decimals. */
  quantity: string;
  /** e.g. "pcs", "kg", "h". Free text; translated unit catalog is a later concern. */
  unit?: string;
  /** Net unit price in document currency; null only on delivery notes. Max 4 decimals. */
  unitPrice: string | null;
  /** Optional line discount percentage, 0–100, max 2 decimals. */
  discountPercent?: string;
  /** Required on priced documents; null on delivery notes. */
  taxCategory: TaxCategorySnapshot | null;
  /**
   * Draft lines only: the company tax category this snapshot was built from. Never part of an
   * issued snapshot. Absent on credit-note lines (they keep the invoice's snapshot) and on lines
   * created before the company catalog existed.
   */
  taxCategoryId?: string;
  /** Optional gross weight in kg for delivery notes / shipping. */
  weightKg?: string;
  /** For credit notes: id of the credited line on the original invoice. */
  sourceLineId?: string;
}

export interface PostalAddress {
  lines: string[];
  postalCode?: string;
  city?: string;
  /** ISO 3166-1 alpha-2. Buyers may be outside LV/LT/EE/PL. */
  countryCode?: string;
}

/** Frozen copy of a party's details as printed on the document. */
export interface PartySnapshot {
  name: string;
  registrationNumber?: string;
  vatNumber?: string;
  address?: PostalAddress;
  /** Separate legal address, when it differs from the main address. */
  legalAddress?: PostalAddress;
  email?: string;
  phone?: string;
  contactName?: string;
}

export interface BankAccountSnapshot {
  bankName?: string;
  iban: string;
  bic?: string;
}

export type DocumentRelationKind = "credits" | "converted_from" | "delivers" | "replaces";

export interface DocumentRelation {
  kind: DocumentRelationKind;
  documentId: string;
  /** Number of the related document as printed (e.g. "INV-2026-0042"). */
  documentNumber: string;
  issueDate: string;
}

export interface DocumentDraft {
  type: DocumentType;
  /** Language the document is rendered in; independent of the UI language. */
  language: AppLocale;
  currency: CurrencyCode;
  /** YYYY-MM-DD */
  issueDate: string;
  /** YYYY-MM-DD; invoices. */
  dueDate?: string;
  /** YYYY-MM-DD; date of supply/delivery if it differs from the issue date. */
  supplyDate?: string;
  /** YYYY-MM-DD; proforma validity. */
  validUntil?: string;
  seller: PartySnapshot;
  buyer: PartySnapshot;
  /** Ship-to party for delivery notes, when different from the buyer. */
  deliverTo?: PartySnapshot;
  bankAccounts: BankAccountSnapshot[];
  /** Buyer's order / PO reference. */
  buyerReference?: string;
  paymentTerms?: string;
  notes?: string;
  /** Footer text configured by the company (e.g. signature statement). */
  footer?: string;
  lines: DocumentLine[];
  relation?: DocumentRelation;
  /**
   * Rate snapshot used to show amounts in a second currency (e.g. tax totals), only when the
   * user chose to. Never re-applied silently after issue.
   */
  exchangeRate?: ExchangeRate;
}

export interface IssuedDocument extends DocumentDraft {
  id: string;
  number: string;
  status: "issued";
  issuedAt: string;
  totals: DocumentTotals | null;
  /** SHA-256 of the canonical snapshot at issue time. */
  contentHash: string;
}

export interface LineAmounts {
  lineId: string;
  /** Rounded net amount of the line (after discount). */
  net: string;
}

export interface TaxSummaryRow {
  code: string;
  kind: TaxTreatmentKind;
  ratePercent: string;
  label: string;
  note?: string;
  taxableAmount: string;
  taxAmount: string;
}

export interface DocumentTotals {
  currency: CurrencyCode;
  lines: LineAmounts[];
  taxSummary: TaxSummaryRow[];
  netTotal: string;
  taxTotal: string;
  grossTotal: string;
  /** Present only when an exchange-rate snapshot is attached. */
  converted?: {
    currency: CurrencyCode;
    rate: ExchangeRate;
    netTotal: string;
    taxTotal: string;
    grossTotal: string;
  };
}

/** Whether the document type carries prices and tax. */
export function isPricedDocument(type: DocumentType): boolean {
  return type !== "delivery_note";
}
