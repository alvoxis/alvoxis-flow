import { type CurrencyCode } from "@/lib/money";
import { type DocumentType } from "../domain/types";

export type Confidence = "high" | "medium" | "low";

/** One extracted value with how sure we are and the text it came from. */
export interface Field<T> {
  value: T | null;
  confidence: Confidence;
  evidence?: string;
}

export type ImportFlagSeverity = "error" | "warning" | "info";

export interface ImportFlag {
  code: string;
  severity: ImportFlagSeverity;
  field?: string;
  detail?: string;
}

export interface ExtractedLine {
  description: string;
  quantity: string | null;
  unit: string | null;
  unitPrice: string | null;
  total: string | null;
  /** Percentages printed on the row (e.g. a tax rate); shown, never interpreted. */
  percentages: string[];
  evidence: string;
  flags: string[];
}

export interface ExtractedIdentifier {
  label: string | null;
  value: string;
  kind: "registration" | "vat" | "unknown";
  side: "seller" | "buyer" | "unknown";
  evidence: string;
}

export interface ExtractedBankAccount {
  iban: string;
  checksumValid: boolean;
  bic: string | null;
  evidence: string;
}

/**
 * Result of reading a PDF. It is ALWAYS a proposal for human review: nothing is created until a
 * user has checked the fields, resolved the flags and chosen the tax treatment explicitly.
 */
export interface ImportReview {
  status: "needs_review";
  fileSha256: string;
  pageCount: number;
  documentType: Field<DocumentType>;
  number: Field<string>;
  issueDate: Field<string>;
  dueDate: Field<string>;
  currency: Field<CurrencyCode>;
  seller: { name: Field<string>; lines: string[] };
  buyer: { name: Field<string>; lines: string[] };
  identifiers: ExtractedIdentifier[];
  bankAccounts: ExtractedBankAccount[];
  buyerReference: Field<string>;
  paymentTerms: Field<string>;
  lines: ExtractedLine[];
  totals: {
    subtotal: Field<string>;
    shipping: Field<string>;
    tax: Field<string>;
    taxRateText: Field<string>;
    total: Field<string>;
  };
  /** Text that may carry tax or legal meaning (e.g. exemption statements); never interpreted. */
  statements: string[];
  flags: ImportFlag[];
  duplicates: DuplicateCandidate[];
}

export interface DuplicateCandidate {
  documentId: string;
  number: string | null;
  reasons: ("same_file" | "same_number" | "same_party_date_total" | "same_date_total")[];
  strength: "certain" | "likely" | "possible";
}
