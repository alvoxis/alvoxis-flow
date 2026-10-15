import { describe, expect, it } from "vitest";
import { SAMPLE_DOCUMENTS, SAMPLE_MONTH } from "@/features/dashboard/sample-data";
import { computeDashboardSummary } from "@/features/dashboard/summary";
import { type DocumentSummary } from "@/features/dashboard/types";

describe("computeDashboardSummary", () => {
  it("keeps totals separated per currency", () => {
    const s = computeDashboardSummary(SAMPLE_DOCUMENTS, SAMPLE_MONTH);
    // EUR invoices issued: 4820.00 (sent) + 2760.40 (paid) + 980.00 (overdue)
    // PLN: 12450.50 (approved); the PLN draft is excluded.
    expect(s.invoicedByCurrency).toEqual([
      { currency: "EUR", amount: "8560.40" },
      { currency: "PLN", amount: "12450.50" },
    ]);
    expect(s.outstandingByCurrency).toEqual([
      { currency: "EUR", amount: "5800.00" },
      { currency: "PLN", amount: "12450.50" },
    ]);
    expect(s.outstandingCount).toBe(3);
    expect(s.overdueByCurrency).toEqual([{ currency: "EUR", amount: "980.00" }]);
    expect(s.overdueCount).toBe(1);
    expect(s.documentCount).toBe(SAMPLE_DOCUMENTS.length);
  });

  it("omits currencies with no amounts and ignores other months", () => {
    const docs: DocumentSummary[] = [
      {
        id: "1",
        number: "A",
        type: "invoice",
        customer: "X",
        issueDate: "2026-09-30",
        status: "paid",
        total: "5.00",
        currency: "PLN",
      },
    ];
    const s = computeDashboardSummary(docs, "2026-10");
    expect(s.invoicedByCurrency).toEqual([]);
    expect(s.documentCount).toBe(0);
  });
});
