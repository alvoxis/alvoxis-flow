import { type CurrencyCode, Money, SUPPORTED_CURRENCIES } from "@/lib/money";

export interface CurrencyTotal {
  currency: CurrencyCode;
  amount: string;
}

/** One row of the company document list, as returned by listDocuments. */
export interface DocumentRow {
  status: "draft" | "issued";
  currency: CurrencyCode;
  /** Stored for issued priced documents only; null for drafts and delivery notes. */
  grossTotal: string | null;
}

export interface DocumentsOverview {
  drafts: number;
  issued: number;
  /** Gross totals of issued documents, per currency (never added across currencies). */
  issuedTotals: CurrencyTotal[];
}

/**
 * Share of issued documents among all of a company's documents, as a whole percentage (0–100), for
 * the dashboard's drafts/issued bar. A display ratio of the two counts, not a money figure.
 */
export function issuedShare(overview: Pick<DocumentsOverview, "drafts" | "issued">): number {
  const all = overview.drafts + overview.issued;
  return all === 0 ? 0 : Math.round((overview.issued / all) * 100);
}

/** Real per-company counts and totals for the dashboard; no payment status exists yet. */
export function summarizeDocuments(rows: readonly DocumentRow[]): DocumentsOverview {
  const issuedRows = rows.filter((r) => r.status === "issued");
  const issuedTotals = SUPPORTED_CURRENCIES.map((currency) => ({
    currency,
    amount: issuedRows
      .filter((r) => r.currency === currency && r.grossTotal !== null)
      .reduce((acc, r) => acc.add(Money.of(r.grossTotal!, currency)), Money.zero(currency)),
  }))
    .filter((t) => !t.amount.isZero())
    .map((t) => ({ currency: t.currency, amount: t.amount.toFixed() }));
  return { drafts: rows.length - issuedRows.length, issued: issuedRows.length, issuedTotals };
}
