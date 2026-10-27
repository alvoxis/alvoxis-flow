import { type CurrencyCode, Money } from "@/lib/money";

/**
 * Payment status of an issued invoice, from recorded data only:
 *   open balance = invoice gross total + issued credit notes (their totals are negative) − payments.
 * Nothing is estimated: without recorded payments an invoice is unpaid, whatever happened at the
 * bank. "Overdue" means an open balance after the due date (an invoice without a due date is never
 * overdue).
 */
export type PaymentStatus = "unpaid" | "partially_paid" | "paid" | "credited";

export interface InvoiceBalanceInput {
  currency: CurrencyCode;
  grossTotal: string;
  /** Sum of the issued credit notes' gross totals (≤ 0). */
  credited: string;
  /** Sum of valid (not voided) payments (≥ 0). */
  paid: string;
  dueDate: string | null;
}

export interface InvoiceBalance {
  balance: string;
  status: PaymentStatus;
  overdue: boolean;
  /** Whole days after the due date, when overdue. */
  daysOverdue: number;
}

/** Days between two ISO dates (b − a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

export function invoiceBalance(input: InvoiceBalanceInput, today: string): InvoiceBalance {
  const gross = Money.of(input.grossTotal, input.currency);
  const credited = Money.of(input.credited, input.currency);
  const paid = Money.of(input.paid, input.currency);
  const due = gross.add(credited);
  const balance = due.subtract(paid);
  const open = !balance.isNegative() && !balance.isZero();
  let status: PaymentStatus;
  if (open) status = paid.isZero() ? "unpaid" : "partially_paid";
  else status = paid.isZero() && !credited.isZero() ? "credited" : "paid";
  const overdue = open && input.dueDate !== null && input.dueDate < today;
  return {
    balance: balance.toFixed(),
    status,
    overdue,
    daysOverdue: overdue ? daysBetween(input.dueDate!, today) : 0,
  };
}

/** Ageing bucket of an overdue amount, for the receivables report. */
export type AgeingBucket = "current" | "1_30" | "31_60" | "61_90" | "over_90";

export function ageingBucket(daysOverdue: number): AgeingBucket {
  if (daysOverdue <= 0) return "current";
  if (daysOverdue <= 30) return "1_30";
  if (daysOverdue <= 60) return "31_60";
  if (daysOverdue <= 90) return "61_90";
  return "over_90";
}

/** A real calendar date in YYYY-MM-DD form (2026-02-31 is not). */
export function isIsoDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const t = Date.parse(`${v}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === v;
}
