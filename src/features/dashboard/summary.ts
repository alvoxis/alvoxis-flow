import { type CurrencyCode, Money, SUPPORTED_CURRENCIES } from "@/lib/money";
import { type DocumentSummary } from "./types";

export interface CurrencyTotal {
  currency: CurrencyCode;
  amount: string;
}

export interface DashboardSummary {
  /** Issued (approved, sent, paid or overdue) invoices this month, grouped per currency. */
  invoicedByCurrency: CurrencyTotal[];
  outstandingByCurrency: CurrencyTotal[];
  outstandingCount: number;
  overdueByCurrency: CurrencyTotal[];
  overdueCount: number;
  documentCount: number;
}

const ISSUED = new Set(["approved", "sent", "paid", "overdue"]);
const UNPAID = new Set(["approved", "sent", "overdue"]);

/**
 * Aggregates documents per currency. Amounts in different currencies are never combined —
 * there is no company base currency.
 */
export function computeDashboardSummary(
  docs: readonly DocumentSummary[],
  month: string,
): DashboardSummary {
  const inMonth = docs.filter((d) => d.issueDate.startsWith(month));

  const totals = (predicate: (d: DocumentSummary) => boolean): CurrencyTotal[] =>
    SUPPORTED_CURRENCIES.map((currency) => {
      const amount = docs
        .filter((d) => d.currency === currency && d.total !== null && predicate(d))
        .reduce((acc, d) => acc.add(Money.of(d.total as string, currency)), Money.zero(currency));
      return { currency, amount };
    })
      .filter((t) => !t.amount.isZero())
      .map((t) => ({ currency: t.currency, amount: t.amount.toFixed() }));

  const issuedInvoice = (d: DocumentSummary) =>
    d.issueDate.startsWith(month) && d.type === "invoice" && ISSUED.has(d.status);
  const unpaid = (d: DocumentSummary) => d.type === "invoice" && UNPAID.has(d.status);
  const overdue = (d: DocumentSummary) => d.type === "invoice" && d.status === "overdue";

  return {
    invoicedByCurrency: totals(issuedInvoice),
    outstandingByCurrency: totals(unpaid),
    outstandingCount: docs.filter(unpaid).length,
    overdueByCurrency: totals(overdue),
    overdueCount: docs.filter(overdue).length,
    documentCount: inMonth.length,
  };
}
