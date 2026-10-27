import { describe, expect, it } from "vitest";
import { expenseCost, expenseGross, nextOccurrence } from "@/modules/finance/domain/expenses";
import {
  ageingBucket,
  daysBetween,
  invoiceBalance,
  isIsoDate,
} from "@/modules/finance/domain/receivables";

/** Payment status and balances of invoices; expense cost rules; date helpers. */
const inv = (over: Partial<Parameters<typeof invoiceBalance>[0]> = {}) => ({
  currency: "EUR" as const,
  grossTotal: "121.00",
  credited: "0",
  paid: "0",
  dueDate: "2026-03-16",
  ...over,
});

describe("invoiceBalance", () => {
  it("derives the status from recorded payments and credit notes only", () => {
    expect(invoiceBalance(inv(), "2026-03-10")).toEqual({
      balance: "121.00",
      status: "unpaid",
      overdue: false,
      daysOverdue: 0,
    });
    expect(invoiceBalance(inv({ paid: "21.01" }), "2026-03-20")).toMatchObject({
      balance: "99.99",
      status: "partially_paid",
      overdue: true,
      daysOverdue: 4,
    });
    expect(invoiceBalance(inv({ paid: "121" }), "2027-01-01")).toMatchObject({
      balance: "0.00",
      status: "paid",
      overdue: false,
    });
    expect(invoiceBalance(inv({ credited: "-121.00" }), "2027-01-01")).toMatchObject({
      status: "credited",
      overdue: false,
    });
    expect(invoiceBalance(inv({ credited: "-21", paid: "100" }), "2027-01-01").status).toBe("paid");
    // No due date: never overdue.
    expect(invoiceBalance(inv({ dueDate: null }), "2030-01-01").overdue).toBe(false);
    // The due date itself is not overdue yet.
    expect(invoiceBalance(inv(), "2026-03-16").overdue).toBe(false);
  });

  it("buckets overdue days", () => {
    expect([0, 1, 30, 31, 60, 61, 90, 91].map(ageingBucket)).toEqual([
      "current",
      "1_30",
      "1_30",
      "31_60",
      "31_60",
      "61_90",
      "61_90",
      "over_90",
    ]);
    expect(daysBetween("2026-02-28", "2026-03-01")).toBe(1);
    expect(daysBetween("2024-02-28", "2024-03-01")).toBe(2);
  });

  it("accepts only real calendar dates", () => {
    expect(isIsoDate("2026-02-28")).toBe(true);
    expect(isIsoDate("2024-02-29")).toBe(true);
    for (const v of ["2026-02-29", "2026-02-31", "2026-13-01", "26-01-01", "2026-1-1", ""])
      expect(isIsoDate(v)).toBe(false);
  });
});

describe("expenses", () => {
  it("never counts recoverable tax as a cost (no double counting of VAT)", () => {
    const e = { currency: "EUR" as const, netAmount: "100.00", taxAmount: "21.00" };
    expect(expenseGross({ ...e, taxRecoverable: true })).toBe("121.00");
    expect(expenseCost({ ...e, taxRecoverable: true })).toBe("100.00");
    expect(expenseCost({ ...e, taxRecoverable: false })).toBe("121.00");
  });

  it("schedules the next occurrence, clamping to the end of shorter months", () => {
    expect(nextOccurrence("2026-01-31", "monthly")).toBe("2026-02-28");
    expect(nextOccurrence("2026-11-30", "quarterly")).toBe("2027-02-28");
    expect(nextOccurrence("2024-02-29", "yearly")).toBe("2025-02-28");
    expect(nextOccurrence("2026-05-15", "none")).toBeNull();
  });
});
