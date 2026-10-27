import { and, eq } from "drizzle-orm";
import { type Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createCreditNoteDraft, issueDocument } from "@/modules/documents/server/document-service";
import { invoiceBalances } from "@/modules/finance/server/payment-service";
import { type Actor } from "@/server/auth/authorization";
import { type Database } from "@/server/db/client";
import { auditLogs, counterparties, documentPayments } from "@/server/db/schema";
import { UnauthenticatedError } from "@/server/errors";
import { issuedInvoice, prepareInvoicing } from "./finance-fixtures";
import { call, issueCodes, params, req, routeHelpers } from "./route-helpers";
import { openTestDb } from "./test-db";

/**
 * Finance over the real route handlers, services and database: payments on issued invoices
 * (derived status, no overpayment, no duplicate reference, void instead of delete, credit notes
 * reduce the balance) and expenses (validation, cost rules, search, CSV, permissions, isolation).
 * Synthetic data only.
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

const paymentsRoute =
  await import("@/app/api/companies/[companyId]/documents/[documentId]/payments/route");
const paymentRoute =
  await import("@/app/api/companies/[companyId]/documents/[documentId]/payments/[paymentId]/route");
const expensesRoute = await import("@/app/api/companies/[companyId]/expenses/route");
const expenseRoute = await import("@/app/api/companies/[companyId]/expenses/[expenseId]/route");
const exportRoute = await import("@/app/api/companies/[companyId]/expenses/export/route");

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
const as = (actor: Actor | null) => {
  session.actor = actor;
};
const today = new Date().toISOString().slice(0, 10);

const api = {
  payments: (companyId: string, documentId: string) =>
    call(paymentsRoute.GET(req("GET"), params({ companyId, documentId }))),
  pay: (companyId: string, documentId: string, body: unknown) =>
    call(paymentsRoute.POST(req("POST", body), params({ companyId, documentId }))),
  void: (companyId: string, documentId: string, paymentId: string) =>
    call(paymentRoute.DELETE(req("DELETE"), params({ companyId, documentId, paymentId }))),
  expenses: (companyId: string, query = "") =>
    call(
      expensesRoute.GET(
        req("GET", undefined, `http://localhost/api?${query}`),
        params({ companyId }),
      ),
    ),
  addExpense: (companyId: string, body: unknown) =>
    call(expensesRoute.POST(req("POST", body), params({ companyId }))),
  putExpense: (companyId: string, expenseId: string, body: unknown) =>
    call(expenseRoute.PUT(req("PUT", body), params({ companyId, expenseId }))),
  deleteExpense: (companyId: string, expenseId: string) =>
    call(expenseRoute.DELETE(req("DELETE"), params({ companyId, expenseId }))),
  exportCsv: async (companyId: string, query = "") => {
    const res = await exportRoute.GET(
      req("GET", undefined, `http://localhost/api?${query}`),
      params({ companyId }),
    );
    const bytes = new Uint8Array(await res.arrayBuffer());
    return {
      status: res.status,
      bom: bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf,
      text: new TextDecoder("utf-8", { ignoreBOM: false }).decode(bytes),
      type: res.headers.get("content-type"),
    };
  },
};

async function invoicingCompany() {
  const c = await h.newCompany("Finanses SIA");
  const cats = await prepareInvoicing(db, c.owner, c.companyId);
  return { ...c, cats };
}

describe("invoice payments", () => {
  it("derives unpaid → partially paid → paid from recorded payments, never overpaid", async () => {
    const c = await invoicingCompany();
    // 100.00 net at 20 % = 120.00 gross, due 2026-03-16 (overdue by now).
    const inv = await issuedInvoice(db, c.owner, c.companyId, c.cats, { net: "100.00" });
    as(c.owner);
    expect((await api.payments(c.companyId, inv.id)).body.payments).toMatchObject({
      grossTotal: "120.00",
      paid: "0.00",
      balance: "120.00",
      status: "unpaid",
      overdue: true,
    });

    const first = await api.pay(c.companyId, inv.id, {
      amount: "50,5",
      paidOn: "2026-03-10",
      method: "bank_transfer",
      reference: "TX-1",
    });
    expect(first.status).toBe(201);
    expect(first.body.payments).toMatchObject({
      paid: "50.50",
      balance: "69.50",
      status: "partially_paid",
    });

    // Above the open balance, a duplicate reference, a future date, zero, malformed.
    const over = await api.pay(c.companyId, inv.id, {
      amount: "69.51",
      paidOn: "2026-03-11",
      method: "cash",
    });
    expect(over.status).toBe(422);
    expect(issueCodes(over.body)).toEqual(["payment.amount.exceedsBalance"]);
    expect(
      (
        await api.pay(c.companyId, inv.id, {
          amount: "1",
          paidOn: "2026-03-11",
          method: "cash",
          reference: "TX-1",
        })
      ).body,
    ).toEqual({ error: "reference_taken" });
    const bad = await api.pay(c.companyId, inv.id, {
      amount: "0",
      paidOn: "2999-01-01",
      method: "card",
    });
    expect(issueCodes(bad.body)).toEqual(["payment.amount.invalid", "payment.paidOn.future"]);
    expect(
      (await api.pay(c.companyId, inv.id, { amount: "1", paidOn: today, method: "crypto" })).status,
    ).toBe(422);

    const second = await api.pay(c.companyId, inv.id, {
      amount: "69.50",
      paidOn: today,
      method: "card",
    });
    expect(second.body.payments).toMatchObject({
      paid: "120.00",
      balance: "0.00",
      status: "paid",
      overdue: false,
    });

    // Voiding keeps the payment in the history and reopens the balance.
    const firstId = second.body.payments.payments[0].id;
    const voided = await api.void(c.companyId, inv.id, firstId);
    expect(voided.body.payments).toMatchObject({ paid: "69.50", status: "partially_paid" });
    expect(voided.body.payments.payments.map((p: { voided: boolean }) => p.voided)).toEqual([
      true,
      false,
    ]);
    expect((await api.void(c.companyId, inv.id, firstId)).body).toMatchObject({
      code: "payments.alreadyVoided",
    });
    // The reference of a voided payment can be used again.
    expect(
      (
        await api.pay(c.companyId, inv.id, {
          amount: "1",
          paidOn: today,
          method: "cash",
          reference: "TX-1",
        })
      ).status,
    ).toBe(201);

    const audits = await db
      .select({ action: auditLogs.action, metadata: auditLogs.metadata })
      .from(auditLogs)
      .where(and(eq(auditLogs.companyId, c.companyId), eq(auditLogs.entityId, inv.id)));
    expect(audits.filter((a) => a.action.startsWith("payment.")).map((a) => a.action)).toEqual([
      "payment.recorded",
      "payment.recorded",
      "payment.voided",
      "payment.recorded",
    ]);
    // Audit entries name no amounts or references.
    expect(JSON.stringify(audits)).not.toContain("TX-1");
  });

  it("counts issued credit notes and refuses drafts, proformas and foreign documents", async () => {
    const c = await invoicingCompany();
    const inv = await issuedInvoice(db, c.owner, c.companyId, c.cats, {
      net: "200.00",
      dueDate: null,
    });
    const note = await createCreditNoteDraft(db, c.owner, c.companyId, inv.id, "full", {
      issueDate: "2026-03-05",
    });
    await issueDocument(db, c.owner, c.companyId, note.id, note.version);
    as(c.owner);
    expect((await api.payments(c.companyId, inv.id)).body.payments).toMatchObject({
      credited: "-240.00",
      balance: "0.00",
      status: "credited",
      overdue: false,
    });
    expect(
      (await api.pay(c.companyId, inv.id, { amount: "1", paidOn: today, method: "cash" })).status,
    ).toBe(422);
    expect((await api.payments(c.companyId, note.id)).body).toMatchObject({
      code: "payments.notIssuedInvoice",
    });

    const other = await invoicingCompany();
    as(other.owner);
    expect((await api.payments(c.companyId, inv.id)).status).toBe(403);
    // Another company's invoice id under this company is simply not found.
    expect((await api.payments(other.companyId, inv.id)).status).toBe(404);
    expect(
      (await api.pay(other.companyId, inv.id, { amount: "1", paidOn: today, method: "cash" }))
        .status,
    ).toBe(404);
  });

  it("allows recording by finance roles only and reports balances per invoice", async () => {
    const c = await invoicingCompany();
    const a = await issuedInvoice(db, c.owner, c.companyId, c.cats, { net: "10.00" });
    await issuedInvoice(db, c.owner, c.companyId, c.cats, {
      net: "5.00",
      dueDate: "2999-12-31",
      currency: "PLN",
    });
    as(await h.member(c.companyId, "manager"));
    expect((await api.payments(c.companyId, a.id)).status).toBe(200);
    expect(
      (await api.pay(c.companyId, a.id, { amount: "1", paidOn: today, method: "cash" })).status,
    ).toBe(403);
    as(await h.member(c.companyId, "warehouse_employee"));
    expect((await api.payments(c.companyId, a.id)).status).toBe(403);
    as(await h.member(c.companyId, "accountant"));
    expect(
      (await api.pay(c.companyId, a.id, { amount: "2", paidOn: today, method: "cash" })).status,
    ).toBe(201);

    const rows = await invoiceBalances(db, c.owner, c.companyId);
    expect(rows.map((r) => [r.currency, r.balance, r.status, r.overdue])).toEqual([
      ["EUR", "10.00", "partially_paid", true],
      ["PLN", "6.00", "unpaid", false],
    ]);
    const stored = await db
      .select()
      .from(documentPayments)
      .where(eq(documentPayments.companyId, c.companyId));
    expect(stored.map((p) => p.source)).toEqual(["manual"]);
  });
});

const expense = (over: Record<string, unknown> = {}) => ({
  expenseDate: "2026-04-10",
  category: "rent",
  description: "Office rent April",
  currency: "EUR",
  netAmount: "500",
  taxAmount: "105",
  taxRecoverable: true,
  status: "paid",
  ...over,
});

describe("expenses", () => {
  it("validates, derives gross and cost, and keeps changes versioned", async () => {
    const c = await h.newCompany();
    as(c.owner);
    const bad = await api.addExpense(
      c.companyId,
      expense({ description: " ", netAmount: "-1", expenseDate: "2026-02-31", dueDate: "x" }),
    );
    expect(bad.status).toBe(422);
    expect(issueCodes(bad.body)).toEqual([
      "expense.amount.invalid",
      "expense.date.invalid",
      "expense.description.required",
      "expense.dueDate.invalid",
    ]);
    expect((await api.addExpense(c.companyId, expense({ category: "yacht" }))).status).toBe(422);

    const rent = (await api.addExpense(c.companyId, expense())).body.expense;
    expect(rent).toMatchObject({
      grossAmount: "605.00",
      costAmount: "500.00",
      paidOn: "2026-04-10",
      source: "manual",
      version: 1,
    });
    // Non-recoverable tax is part of the cost.
    const fuel = (
      await api.addExpense(
        c.companyId,
        expense({
          category: "transport",
          description: "Fuel",
          netAmount: "80",
          taxAmount: "16.80",
          taxRecoverable: false,
          status: "unpaid",
          dueDate: "2026-04-01",
          supplierName: "=cmd|' /C calc'!A0",
        }),
      )
    ).body.expense;
    expect(fuel).toMatchObject({ costAmount: "96.80", paidOn: null, overdue: true });

    const changed = await api.putExpense(c.companyId, fuel.id, {
      ...expense({
        category: "transport",
        description: "Fuel",
        netAmount: "80",
        taxAmount: "16.80",
      }),
      supplierName: "=cmd|' /C calc'!A0",
      taxRecoverable: false,
      expectedVersion: 1,
    });
    expect(changed.body.expense).toMatchObject({ status: "paid", version: 2, overdue: false });
    expect(
      (await api.putExpense(c.companyId, fuel.id, { ...expense(), expectedVersion: 1 })).body,
    ).toEqual({
      error: "version_conflict",
    });

    // Search, filters, sorting.
    expect((await api.expenses(c.companyId, "q=fuel")).body.total).toBe(1);
    expect((await api.expenses(c.companyId, "category=rent")).body.expenses).toHaveLength(1);
    expect(
      (await api.expenses(c.companyId, "sort=amount_desc")).body.expenses.map(
        (e: { description: string }) => e.description,
      ),
    ).toEqual(["Office rent April", "Fuel"]);
    expect((await api.expenses(c.companyId, "category=nope")).status).toBe(422);

    // CSV: quoted text, formula injection neutralised, BOM.
    const csv = await api.exportCsv(c.companyId);
    expect(csv.type).toContain("text/csv");
    expect(csv.bom).toBe(true);
    expect(csv.text.startsWith("date;category;description")).toBe(true);
    expect(csv.text).toContain(`"'=cmd|' /C calc'!A0"`);

    expect((await api.deleteExpense(c.companyId, rent.id)).body).toEqual({ deleted: true });
    expect((await api.deleteExpense(c.companyId, rent.id)).status).toBe(404);
    expect((await api.expenses(c.companyId)).body.total).toBe(1);
  });

  it("links only the company's own suppliers and isolates companies and roles", async () => {
    const c = await h.newCompany();
    const other = await h.newCompany();
    const [foreign] = await db
      .insert(counterparties)
      .values({ companyId: other.companyId, name: "Svešs SIA", isSupplier: true })
      .returning();
    const [own] = await db
      .insert(counterparties)
      .values({ companyId: c.companyId, name: "Savs SIA", isSupplier: true })
      .returning();
    as(c.owner);
    expect(
      issueCodes((await api.addExpense(c.companyId, expense({ supplierId: foreign!.id }))).body),
    ).toEqual(["expense.supplier.unknown"]);
    const linked = (await api.addExpense(c.companyId, expense({ supplierId: own!.id }))).body
      .expense;
    expect(linked.supplierName).toBe("Savs SIA");

    as(other.owner);
    expect((await api.expenses(c.companyId)).status).toBe(403);
    expect((await api.deleteExpense(other.companyId, linked.id)).status).toBe(404);
    expect((await api.exportCsv(c.companyId)).status).toBe(403);
    as(await h.member(c.companyId, "manager"));
    expect((await api.expenses(c.companyId)).body.total).toBe(1);
    expect((await api.addExpense(c.companyId, expense())).status).toBe(403);
    as(await h.member(c.companyId, "production_employee"));
    expect((await api.expenses(c.companyId)).status).toBe(403);
  });
});
