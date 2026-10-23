import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { type Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type * as DocumentService from "@/modules/documents/server/document-service";
import {
  createCreditNoteDraft,
  createDraft,
  issueDocument,
} from "@/modules/documents/server/document-service";
import { ensureDefaultNumberSeries } from "@/modules/documents/server/numbering-service";
import { type Actor } from "@/server/auth/authorization";
import { type AuthenticatedUser } from "@/server/auth/session";
import { type Database } from "@/server/db/client";
import { companies, memberships, roles, users } from "@/server/db/schema";
import { createCompanyWithOwner } from "@/server/tenancy/company-service";
import { FIXTURE_SELLER_PROFILE, invoiceDraft } from "../support/document-fixtures";
import { addFixtureTaxCategories, withCategoryIds } from "../support/tax-category-fixtures";
import { openTestDb } from "./test-db";

/** Dashboard and "Documents" entry loaders: real figures, same access rules. Synthetic data. */
const state = vi.hoisted(() => ({ db: undefined as unknown, failList: false }));
vi.mock("@/server/db/client", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getDb: () => state.db,
}));
// `failList` simulates the document figures failing to load (e.g. a database timeout).
vi.mock("@/modules/documents/server/document-service", async (importOriginal) => {
  const actual = await importOriginal<typeof DocumentService>();
  return {
    ...actual,
    listDocuments: (...args: Parameters<typeof actual.listDocuments>) => {
      if (state.failList) throw new Error("synthetic outage");
      return actual.listDocuments(...args);
    },
  };
});
vi.mock("@/server/auth/instance", () => ({ getMailer: () => ({ configured: false }) }));

const { dashboardData, documentsEntryData } = await import("@/server/account/page-data");

let db: Database;
let pool: Pool;
beforeAll(() => {
  ({ db, pool } = openTestDb());
  state.db = db;
});
afterAll(async () => pool.end());

const actorOf = (userId: string): Actor => ({ userId, twoFactorVerified: true });
const pageUser = (userId: string, twoFactorVerified = true) =>
  ({ userId, twoFactorVerified }) as AuthenticatedUser;

async function newUser() {
  const [u] = await db
    .insert(users)
    .values({ email: `dash-${randomUUID()}@example.test` })
    .returning();
  return u!;
}

async function member(companyId: string, roleKey: string) {
  const u = await newUser();
  const [role] = await db
    .select()
    .from(roles)
    .where(and(eq(roles.companyId, companyId), eq(roles.key, roleKey)));
  await db.insert(memberships).values({ companyId, userId: u.id, roleId: role!.id });
  return u.id;
}

async function companyWithDocuments(name: string) {
  const owner = actorOf((await newUser()).id);
  const { companyId } = await createCompanyWithOwner(db, owner, { name, country: "LV" });
  await db.update(companies).set(FIXTURE_SELLER_PROFILE).where(eq(companies.id, companyId));
  await ensureDefaultNumberSeries(db, owner, companyId);
  const cats = await addFixtureTaxCategories(db, owner, companyId);
  const { lines, relation: _r, bankAccounts: _b, ...rest } = invoiceDraft();
  const input = {
    ...rest,
    lines: withCategoryIds(
      lines.map(({ id: _id, sourceLineId: _s, ...l }) => l),
      cats,
    ),
  };
  await createDraft(db, owner, companyId, input);
  const toIssue = await createDraft(db, owner, companyId, input);
  const issued = await issueDocument(db, owner, companyId, toIssue.id, toIssue.version);
  return { owner, companyId, input, issued, issuedGross: issued.totals!.grossTotal };
}

describe("dashboard data", () => {
  it("shows real counts and per-currency invoiced totals for the owner's company", async () => {
    const { owner, companyId, issuedGross } = await companyWithDocuments("Pārskats SIA");
    const { companies: list, twoFactorMissing } = await dashboardData(pageUser(owner.userId));
    expect(twoFactorMissing).toBe(false);
    expect(list).toEqual([
      expect.objectContaining({
        id: companyId,
        roleKey: "owner",
        documents: {
          status: "ok",
          canCreate: true,
          overview: {
            drafts: 1,
            issued: 1,
            invoicedTotals: [{ currency: "EUR", amount: issuedGross }],
          },
        },
      }),
    ]);
  });

  it("invoiced totals: credit notes subtract, proformas are not invoices, currencies stay apart", async () => {
    const { owner, companyId, input, issued, issuedGross } =
      await companyWithDocuments("Kredīts SIA");
    // A full credit note of the invoice: the EUR total goes to zero (and disappears).
    const note = await createCreditNoteDraft(db, owner, companyId, issued.id, "full", {
      issueDate: "2026-03-10",
    });
    await issueDocument(db, owner, companyId, note.id, note.version);
    // An issued proforma and an issued PLN invoice.
    const proforma = await createDraft(db, owner, companyId, { ...input, type: "proforma" });
    await issueDocument(db, owner, companyId, proforma.id, proforma.version);
    const pln = await createDraft(db, owner, companyId, { ...input, currency: "PLN" });
    const plnIssued = await issueDocument(db, owner, companyId, pln.id, pln.version);

    const [card] = (await dashboardData(pageUser(owner.userId))).companies;
    expect(card!.documents).toEqual({
      status: "ok",
      canCreate: true,
      overview: {
        drafts: 1,
        issued: 4,
        invoicedTotals: [{ currency: "PLN", amount: plnIssued.totals!.grossTotal }],
      },
    });
    expect(issuedGross).not.toBe("0.00");
  });

  it("an empty company has zero figures, not sample data", async () => {
    const owner = actorOf((await newUser()).id);
    const { companyId } = await createCompanyWithOwner(db, owner, { name: "Tukšs", country: "EE" });
    const { companies: list } = await dashboardData(pageUser(owner.userId));
    expect(list).toEqual([
      expect.objectContaining({
        id: companyId,
        documents: {
          status: "ok",
          canCreate: true,
          overview: { drafts: 0, issued: 0, invoicedTotals: [] },
        },
      }),
    ]);
  });

  it("without access to documents the figures are withheld (role, missing 2FA)", async () => {
    const { owner, companyId } = await companyWithDocuments("Piekļuve SIA");
    // Owner whose session has not passed 2FA: the company is listed, its figures are not.
    const noTwoFactor = await dashboardData(pageUser(owner.userId, false));
    expect(noTwoFactor.twoFactorMissing).toBe(true);
    expect(noTwoFactor.companies).toEqual([
      expect.objectContaining({ id: companyId, documents: { status: "no_access" } }),
    ]);
    // No documents.view (production employee) → null; documents.view (warehouse) → figures.
    const production = await dashboardData(
      pageUser(await member(companyId, "production_employee")),
    );
    expect(production.companies).toEqual([
      expect.objectContaining({ id: companyId, documents: { status: "no_access" } }),
    ]);
    // documents.view without documents.create: figures, but no "create" action.
    const warehouse = await dashboardData(pageUser(await member(companyId, "warehouse_employee")));
    expect(warehouse.companies[0]!.documents).toMatchObject({
      status: "ok",
      canCreate: false,
      overview: { drafts: 1, issued: 1 },
    });
  });

  it("a loading failure is an error state, not an empty company, and logs no data", async () => {
    const { owner, companyId } = await companyWithDocuments("Kļūda SIA");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    state.failList = true;
    try {
      const { companies: list } = await dashboardData(pageUser(owner.userId));
      expect(list).toEqual([
        expect.objectContaining({ id: companyId, documents: { status: "error" } }),
      ]);
      expect(JSON.stringify(logged.mock.calls)).not.toContain("synthetic outage");
      expect(JSON.stringify(logged.mock.calls)).not.toContain("Kļūda SIA");
    } finally {
      state.failList = false;
      logged.mockRestore();
    }
  });

  it("never includes other tenants, on the dashboard or in the Documents entry", async () => {
    const a = await companyWithDocuments("A SIA");
    const b = await companyWithDocuments("B SIA");
    const dash = await dashboardData(pageUser(a.owner.userId));
    expect(dash.companies.map((c) => c.id)).toEqual([a.companyId]);
    expect((await documentsEntryData(pageUser(a.owner.userId))).map((c) => c.id)).toEqual([
      a.companyId,
    ]);
    expect((await documentsEntryData(pageUser(b.owner.userId))).map((c) => c.id)).toEqual([
      b.companyId,
    ]);
    // Archived companies disappear from both.
    await db.update(companies).set({ archivedAt: new Date() }).where(eq(companies.id, a.companyId));
    expect((await dashboardData(pageUser(a.owner.userId))).companies).toEqual([]);
    expect(await documentsEntryData(pageUser(a.owner.userId))).toEqual([]);
  });
});
