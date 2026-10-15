import { type CurrencyCode } from "@/lib/money";

export type DocumentType = "invoice" | "proforma" | "creditNote" | "deliveryNote";
export type DocumentStatus = "draft" | "approved" | "sent" | "paid" | "overdue" | "delivered";

export interface DocumentSummary {
  id: string;
  number: string;
  type: DocumentType;
  customer: string;
  /** YYYY-MM-DD */
  issueDate: string;
  status: DocumentStatus;
  /** Gross total as a decimal string; null for documents without monetary value. */
  total: string | null;
  currency: CurrencyCode;
  /** For credit notes: number of the original invoice. */
  creditsDocumentNumber?: string;
}
