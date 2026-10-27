import { type CurrencyCode, Money } from "@/lib/money";

/** Fixed expense categories (labels are translated; the keys are stored). */
export const EXPENSE_CATEGORIES = [
  "materials",
  "goods_for_resale",
  "rent",
  "utilities",
  "salaries",
  "taxes_fees",
  "transport",
  "marketing",
  "software",
  "professional_services",
  "equipment",
  "travel",
  "bank_fees",
  "other",
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export const PAYMENT_METHODS = ["bank_transfer", "card", "cash", "other"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const RECURRENCES = ["none", "monthly", "quarterly", "yearly"] as const;
export type Recurrence = (typeof RECURRENCES)[number];

export interface ExpenseAmounts {
  currency: CurrencyCode;
  netAmount: string;
  taxAmount: string;
  taxRecoverable: boolean;
}

/** What the supplier is paid: net + tax. */
export function expenseGross(e: ExpenseAmounts): string {
  return Money.of(e.netAmount, e.currency).add(Money.of(e.taxAmount, e.currency)).toFixed();
}

/**
 * The expense as a cost of the business: recoverable tax (input VAT the company may deduct) is not
 * a cost, so only the net amount counts; non-recoverable tax is part of the cost. Whether tax is
 * recoverable depends on the company's VAT registration and the purchase, and is entered by the
 * user — it is never assumed from a rate.
 */
export function expenseCost(e: ExpenseAmounts): string {
  const net = Money.of(e.netAmount, e.currency);
  return (e.taxRecoverable ? net : net.add(Money.of(e.taxAmount, e.currency))).toFixed();
}

/** The date of the next occurrence of a recurring expense (end of month clamps: 31 Jan → 28/29 Feb). */
export function nextOccurrence(date: string, recurrence: Recurrence): string | null {
  const months = { none: 0, monthly: 1, quarterly: 3, yearly: 12 }[recurrence];
  if (months === 0) return null;
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}
