import { type Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { businessDashboard } from "@/modules/dashboard/server/business-dashboard";
import { createExpense } from "@/modules/finance/server/expense-service";
import { recordPayment } from "@/modules/finance/server/payment-service";
import { type Database } from "@/server/db/client";
import { ForbiddenError } from "@/server/errors";
import { issuedInvoice, prepareInvoicing } from "./finance-fixtures";
import { routeHelpers } from "./route-helpers";
import { openTestDb } from "./test-db";

/**
 * The business dashboard from real records: revenue, direct costs, expenses, result and margin per
 * currency, cash in/out, receivables and payables, the previous period, buckets, sections by role,
 * and other companies' data never counted. Synthetic data only.
 */
let db: Database;
let pool: Pool;
beforeAll(() => {
  ({ db, pool } = openTestDb());
});
afterAll(async () => pool.end());
const h = routeHelpers(() => db);

const expense = (over: Record<string, unknown>) => ({
  expenseDate: "2026-03-10",
  category: "rent",
  description: "Fixture expense",
  currency: "EUR",
  netAmount: "100",
  taxAmount: "0",
  status: "paid",
  ...over,
});

describe("business dashboard", () => {
  it("adds up revenue, costs, cash and open items from records, per currency", async () => {
    const c = await h.newCompany("Panelis SIA");
    const cats = await prepareInvoicing(db, c.owner, c.companyId);
    // March: two invoices (net 1000 + 500 = 1500, gross 1800), one paid in full (1200).
    const a = await issuedInvoice(db, c.owner, c.companyId, cats, {
      net: "1000",
      issueDate: "2026-03-02",
      dueDate: "2026-03-20",
    });
    await issuedInvoice(db, c.owner, c.companyId, cats, {
      net: "500",
      issueDate: "2026-03-15",
      dueDate: "2999-01-01",
    });
    // February (previous period of March): 400 net.
    await issuedInvoice(db, c.owner, c.companyId, cats, {
      net: "400",
      issueDate: "2026-02-10",
      dueDate: "2026-02-20",
    });
    // PLN stays separate.
    await issuedInvoice(db, c.owner, c.companyId, cats, {
      net: "50",
      issueDate: "2026-03-05",
      currency: "PLN",
      zero: true,
    });
    await recordPayment(db, c.owner, c.companyId, a.id, {
      amount: "1200",
      paidOn: "2026-03-18",
      method: "bank_transfer",
    });
    await createExpense(
      db,
      c.owner,
      c.companyId,
      expense({ category: "materials", netAmount: "300", taxAmount: "63" }),
    );
    await createExpense(
      db,
      c.owner,
      c.companyId,
      expense({
        netAmount: "200",
        taxAmount: "42",
        taxRecoverable: false,
        status: "unpaid",
        dueDate: "2026-03-01",
      }),
    );

    const other = await h.newCompany();
    const otherCats = await prepareInvoicing(db, other.owner, other.companyId);
    await issuedInvoice(db, other.owner, other.companyId, otherCats, {
      net: "99999",
      issueDate: "2026-03-03",
    });

    const d = await businessDashboard(db, c.owner, c.companyId, {
      from: "2026-03-01",
      to: "2026-03-31",
    });
    expect(d.bucket).toBe("day");
    expect(d.previous).toEqual({ from: "2026-01-29", to: "2026-02-28" });
    expect(d.currencies).toEqual(["EUR", "PLN"]);
    expect(d.figures.find((f) => f.currency === "EUR")).toEqual({
      currency: "EUR",
      revenue: "1500.00",
      directCosts: "300.00",
      expenses: "542.00",
      grossProfit: "1200.00",
      result: "958.00",
      marginPercent: "63.9",
      cashIn: "1200.00",
      cashOut: "363.00",
      netCash: "837.00",
    });
    expect(d.figures.find((f) => f.currency === "PLN")).toMatchObject({
      revenue: "50.00",
      marginPercent: "100.0",
    });
    expect(d.previousFigures.find((f) => f.currency === "EUR")).toMatchObject({
      revenue: "400.00",
      expenses: "0.00",
    });
    const march2 = d.series.EUR!.find((p) => p.key === "2026-03-02");
    expect(march2).toMatchObject({ revenue: "1000.00" });
    expect(d.series.EUR).toHaveLength(31);

    // Receivables today: invoice 2 (600) open, not overdue; February's (480) open and overdue.
    expect(d.receivables?.find((r) => r.currency === "EUR")).toEqual({
      currency: "EUR",
      open: "1080.00",
      openCount: 2,
      overdue: "480.00",
      overdueCount: 1,
    });
    // The PLN invoice (due 2026-03-16) is unpaid and overdue.
    expect(d.invoiceStatus).toEqual({
      paid: 1,
      partiallyPaid: 0,
      unpaid: 2,
      credited: 0,
      overdue: 1,
    });
    expect(d.payables).toEqual([
      { currency: "EUR", open: "242.00", openCount: 1, overdue: "242.00", overdueCount: 1 },
    ]);
    expect(d.expenseCategories).toEqual([
      { currency: "EUR", category: "materials", cost: "300.00" },
      { currency: "EUR", category: "rent", cost: "242.00" },
    ]);
    expect(d.activity?.some((a) => a.action === "payment.recorded")).toBe(true);

    // A year: monthly buckets.
    const year = await businessDashboard(db, c.owner, c.companyId, {
      from: "2026-01-01",
      to: "2026-12-31",
    });
    expect(year.bucket).toBe("month");
    expect(year.series.EUR!.map((p) => p.revenue).slice(0, 3)).toEqual([
      "0.00",
      "400.00",
      "1500.00",
    ]);
  });

  it("shows each role only its sections, and nothing to outsiders", async () => {
    const c = await h.newCompany();
    const warehouse = await businessDashboard(
      db,
      await h.member(c.companyId, "warehouse_employee"),
      c.companyId,
      {
        from: "2026-03-01",
        to: "2026-03-31",
      },
    );
    expect(warehouse.sections).toEqual({
      sales: false,
      finance: false,
      stock: true,
      activity: false,
    });
    expect(warehouse.receivables).toBeNull();
    expect(warehouse.payables).toBeNull();
    const manager = await businessDashboard(
      db,
      await h.member(c.companyId, "manager"),
      c.companyId,
      {
        from: "2026-03-01",
        to: "2026-03-31",
      },
    );
    expect(manager.sections).toMatchObject({ sales: true, finance: true, activity: false });
    expect(manager.activity).toBeNull();
    const outsider = await h.newCompany();
    await expect(
      businessDashboard(db, outsider.owner, c.companyId, { from: "2026-03-01", to: "2026-03-31" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
