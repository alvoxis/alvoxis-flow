import { type Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createExpense } from "@/modules/finance/server/expense-service";
import { recordPayment } from "@/modules/finance/server/payment-service";
import { type Actor } from "@/server/auth/authorization";
import { type Database } from "@/server/db/client";
import { UnauthenticatedError } from "@/server/errors";
import { issuedInvoice, prepareInvoicing } from "./finance-fixtures";
import { call, params, req, routeHelpers } from "./route-helpers";
import { openTestDb } from "./test-db";

/**
 * Reports over the real route: receivables with ageing, VAT summary (output from issued invoices,
 * recoverable input from expenses), profit and loss, CSV export, permissions per report and
 * isolation. The 20 % rate is an arbitrary fixture value. Synthetic data only.
 */
const session = vi.hoisted(() => ({
  db: undefined as unknown,
  actor: null as { userId: string; twoFactorVerified: boolean } | null,
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/server/auth/instance", () => ({ getAuth: () => ({}) }));
vi.mock("@/server/db/client", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getDb: () => session.db,
}));
vi.mock("@/server/auth/session", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  requireUser: async () => {
    if (!session.actor) throw new UnauthenticatedError();
    return { ...session.actor, sessionId: "test-session" };
  },
}));
const route = await import("@/app/api/companies/[companyId]/reports/[report]/route");

let db: Database;
let pool: Pool;
beforeAll(() => {
  ({ db, pool } = openTestDb());
  session.db = db;
});
afterAll(async () => pool.end());
beforeEach(() => {
  session.actor = null;
});
const h = routeHelpers(() => db);
const as = (a: Actor | null) => {
  session.actor = a;
};
const get = (
  companyId: string,
  report: string,
  qs = "range=custom&from=2026-03-01&to=2026-03-31",
) =>
  call(
    route.GET(req("GET", undefined, `http://localhost/api?${qs}`), params({ companyId, report })),
  );

describe("reports", () => {
  it("builds receivables, VAT and P&L from records and exports CSV", async () => {
    const c = await h.newCompany();
    const cats = await prepareInvoicing(db, c.owner, c.companyId);
    const a = await issuedInvoice(db, c.owner, c.companyId, cats, {
      net: "100",
      issueDate: "2026-03-02",
      dueDate: "2026-03-10",
      buyer: "Vecs Parāds SIA",
    });
    await issuedInvoice(db, c.owner, c.companyId, cats, {
      net: "50",
      issueDate: "2026-03-20",
      dueDate: "2999-01-01",
      buyer: "Jauns SIA",
    });
    await recordPayment(db, c.owner, c.companyId, a.id, {
      amount: "20",
      paidOn: "2026-03-11",
      method: "cash",
    });
    await createExpense(db, c.owner, c.companyId, {
      expenseDate: "2026-03-05",
      category: "materials",
      description: "Audums",
      currency: "EUR",
      netAmount: "40",
      taxAmount: "8.40",
      taxRecoverable: true,
      status: "paid",
    });
    await createExpense(db, c.owner, c.companyId, {
      expenseDate: "2026-03-06",
      category: "travel",
      description: "Viesnīca",
      currency: "EUR",
      netAmount: "60",
      taxAmount: "7",
      taxRecoverable: false,
      status: "paid",
    });
    as(c.owner);

    const rec = (await get(c.companyId, "receivables")).body.report;
    expect(rec.rows.map((r: string[]) => [r[1], r[7], r[9]])).toEqual([
      ["Vecs Parāds SIA", "100.00", expect.stringMatching(/over_90|61_90|31_60|1_30/)],
      ["Jauns SIA", "60.00", "current"],
    ]);
    expect(rec.totals).toEqual([["total", "", "", "", "EUR", "180.00", "20.00", "160.00", "", ""]]);

    const vat = (await get(c.companyId, "vat")).body.report;
    expect(vat.rows).toEqual([
      ["output", "EUR", "T20", "standard", "20", "150.00", "30.00"],
      ["input", "EUR", "", "recorded_expenses", "", "40.00", "8.40"],
    ]);
    expect(vat.totals).toEqual([["balance", "EUR", "", "", "", "", "21.60"]]);

    const pnl = (await get(c.companyId, "pnl")).body.report;
    expect(pnl.totals).toEqual([["total", "EUR", "150.00", "107.00", "43.00", "20.00", "115.40"]]);

    const csv = await route.GET(
      req(
        "GET",
        undefined,
        "http://localhost/api?range=custom&from=2026-03-01&to=2026-03-31&format=csv",
      ),
      params({ companyId: c.companyId, report: "vat" }),
    );
    expect(csv.headers.get("content-type")).toContain("text/csv");
    const text = new TextDecoder().decode(await csv.arrayBuffer());
    expect(text).toContain("direction;currency;code;treatment;ratePercent;taxable;tax");
    expect(text).toContain('"balance";"EUR";"";"";;;21.60');
  });

  it("checks each report's permissions and never shows other companies", async () => {
    const c = await h.newCompany();
    const other = await h.newCompany();
    as(await h.member(c.companyId, "warehouse_employee"));
    expect((await get(c.companyId, "stock")).status).toBe(200);
    expect((await get(c.companyId, "vat")).status).toBe(403);
    expect((await get(c.companyId, "pnl")).status).toBe(403);
    as(other.owner);
    expect((await get(c.companyId, "receivables")).status).toBe(403);
    expect((await get(c.companyId, "nope")).status).toBe(400);
    as(null);
    expect((await get(c.companyId, "stock")).status).toBe(401);
  });
});
