import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { type Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DOCUMENT_PAGE_SIZE,
  EMPTY_DOCUMENT_QUERY,
  parseDocumentListQuery,
} from "@/features/documents/list-query";
import {
  createCreditNoteDraft,
  createDraft,
  issueDocument,
  listRelatedDocuments,
  searchDocuments,
} from "@/modules/documents/server/document-service";
import type * as DocumentService from "@/modules/documents/server/document-service";
import { ensureDefaultNumberSeries } from "@/modules/documents/server/numbering-service";
import { type Actor } from "@/server/auth/authorization";
import { type AuthenticatedUser } from "@/server/auth/session";
import { type Database } from "@/server/db/client";
import { companies, documents, memberships, roles, users } from "@/server/db/schema";
import { documentPageData, documentsListData } from "@/server/documents/page-data";
import { ForbiddenError, TwoFactorRequiredError } from "@/server/errors";
import { createCompanyWithOwner } from "@/server/tenancy/company-service";
import { FIXTURE_SELLER_PROFILE, invoiceDraft } from "../support/document-fixtures";
import {
  addFixtureTaxCategories,
  type FixtureCategoryIds,
  withCategoryIds,
} from "../support/tax-category-fixtures";
import { openTestDb } from "./test-db";

/**
 * Documents workspace: server-side search, filters, sorting and paging of the document list, and
 * the invoice ↔ credit note relation, through the real services and database. Synthetic data.
 */
const state = vi.hoisted(() => ({ db: undefined as unknown, failRelated: false }));
vi.mock("@/server/db/client", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getDb: () => state.db,
}));
vi.mock("@/modules/documents/server/document-service", async (importOriginal) => {
  const actual = await importOriginal<typeof DocumentService>();
  return {
    ...actual,
    listRelatedDocuments: (...args: Parameters<typeof actual.listRelatedDocuments>) =>
      state.failRelated
        ? Promise.reject(new Error("simulated database outage"))
        : actual.listRelatedDocuments(...args),
  };
});

let db: Database;
let pool: Pool;
beforeAll(() => {
  ({ db, pool } = openTestDb());
  state.db = db;
});
afterAll(async () => pool.end());
beforeEach(() => {
  state.failRelated = false;
});

const actorOf = (userId: string): Actor => ({ userId, twoFactorVerified: true });
const pageUser = (a: Actor): AuthenticatedUser => ({
  userId: a.userId,
  email: "ws@example.test",
  displayName: null,
  locale: "en",
  emailVerified: true,
  twoFactorEnabled: a.twoFactorVerified,
  sessionId: "test-session",
  twoFactorVerified: a.twoFactorVerified,
});

async function newUser() {
  const [u] = await db
    .insert(users)
    .values({ email: `ws-${randomUUID()}@example.test` })
    .returning();
  return u!;
}

async function newCompany() {
  const owner = actorOf((await newUser()).id);
  const { companyId } = await createCompanyWithOwner(db, owner, { name: "WS Co", country: "LV" });
  await db.update(companies).set(FIXTURE_SELLER_PROFILE).where(eq(companies.id, companyId));
  await ensureDefaultNumberSeries(db, owner, companyId);
  const cats = await addFixtureTaxCategories(db, owner, companyId);
  return { owner, companyId, cats };
}

async function member(companyId: string, roleKey: string) {
  const u = await newUser();
  const [role] = await db
    .select()
    .from(roles)
    .where(and(eq(roles.companyId, companyId), eq(roles.key, roleKey)));
  await db.insert(memberships).values({ companyId, userId: u.id, roleId: role!.id });
  return actorOf(u.id);
}

function input(
  cats: FixtureCategoryIds,
  overrides: Parameters<typeof invoiceDraft>[0] = {},
  quantity?: string,
) {
  const { lines, relation: _r, bankAccounts: _b, ...rest } = invoiceDraft(overrides);
  return {
    ...rest,
    lines: withCategoryIds(
      lines.map(({ id: _i, sourceLineId: _s, ...l }) => (quantity ? { ...l, quantity } : l)),
      cats,
    ),
  };
}

const q = (params: Record<string, string> = {}) => parseDocumentListQuery(params);

describe("document search", () => {
  /** Two issued invoices, an issued proforma and two drafts, on different dates and buyers. */
  async function seeded() {
    const c = await newCompany();
    const mk = async (
      overrides: Parameters<typeof invoiceDraft>[0],
      issue: boolean,
      qty?: string,
    ) => {
      const d = await createDraft(db, c.owner, c.companyId, input(c.cats, overrides, qty));
      return issue ? issueDocument(db, c.owner, c.companyId, d.id, 1) : d;
    };
    const a = await mk({ buyer: { name: "Alfa Kurpes SIA" }, issueDate: "2026-03-02" }, true, "1");
    const b = await mk(
      { buyer: { name: "Beta 100%_Boots Ltd" }, issueDate: "2026-03-05" },
      true,
      "3",
    );
    const p = await mk(
      { type: "proforma", buyer: { name: "Gamma SIA" }, issueDate: "2026-03-04" },
      true,
    );
    const d1 = await mk({ buyer: { name: "Alfa Kurpes SIA" }, issueDate: "2026-03-10" }, false);
    const d2 = await mk({ buyer: { name: "Delta   Rīga" }, issueDate: "2026-02-20" }, false);
    return { ...c, a, b, p, d1, d2 };
  }
  const ids = (r: { documents: { id: string }[] }) => r.documents.map((d) => d.id);

  it("finds by number or buyer name, case-insensitively, ignoring extra spaces", async () => {
    const s = await seeded();
    const search = (text: string) =>
      searchDocuments(db, s.owner, s.companyId, q({ q: text })).then(ids);
    expect(await search("inv-2026-0002")).toEqual([s.b.id]);
    expect(await search("  ALFA   kurpes ")).toEqual([s.d1.id, s.a.id]);
    expect(await search("rīga")).toEqual([s.d2.id]);
    // LIKE wildcards in the search text match literally.
    expect(await search("100%_b")).toEqual([s.b.id]);
    expect(await search("%")).toEqual([s.b.id]);
    expect(await search("_")).toEqual([s.b.id]);
    expect(await search("nothing like this")).toEqual([]);
  });

  it("filters by type, status and issue-date range (inclusive)", async () => {
    const s = await seeded();
    const run = (params: Record<string, string>) =>
      searchDocuments(db, s.owner, s.companyId, q(params));
    expect(ids(await run({ type: "proforma" }))).toEqual([s.p.id]);
    expect(ids(await run({ status: "draft" }))).toEqual([s.d1.id, s.d2.id]);
    expect(ids(await run({ type: "invoice", status: "issued" }))).toEqual([s.b.id, s.a.id]);
    expect(ids(await run({ from: "2026-03-02", to: "2026-03-05" }))).toEqual([
      s.b.id,
      s.p.id,
      s.a.id,
    ]);
    expect(ids(await run({ from: "2026-03-06" }))).toEqual([s.d1.id]);
    expect(ids(await run({ to: "2026-02-28" }))).toEqual([s.d2.id]);
    const combined = await run({ q: "alfa", status: "issued", from: "2026-03-01" });
    expect(combined).toEqual({ documents: [expect.objectContaining({ id: s.a.id })], total: 1 });
  });

  it("sorts by date, number and amount (within a currency; no number or total last)", async () => {
    const s = await seeded();
    const run = (sort: string) => searchDocuments(db, s.owner, s.companyId, q({ sort })).then(ids);
    expect(await run("date_desc")).toEqual([s.d1.id, s.b.id, s.p.id, s.a.id, s.d2.id]);
    expect(await run("date_asc")).toEqual([s.d2.id, s.a.id, s.p.id, s.b.id, s.d1.id]);
    // Numbers: INV-2026-0001 (a), INV-2026-0002 (b), PF-2026-0001 (p); drafts have none.
    expect((await run("number_asc")).slice(0, 3)).toEqual([s.a.id, s.b.id, s.p.id]);
    expect((await run("number_desc")).slice(0, 3)).toEqual([s.p.id, s.b.id, s.a.id]);
    expect((await run("number_asc")).slice(3).sort()).toEqual([s.d1.id, s.d2.id].sort());
    // Amounts: b (3 × each line) > p (fixture quantities) > a (1 each); drafts have no total.
    const byAmount = await run("amount_desc");
    const totals = (await searchDocuments(db, s.owner, s.companyId, q({ sort: "amount_desc" })))
      .documents;
    const issuedTotals = totals.filter((d) => d.grossTotal).map((d) => Number(d.grossTotal));
    expect(issuedTotals).toEqual([...issuedTotals].sort((x, y) => y - x));
    expect(byAmount.slice(3).sort()).toEqual([s.d1.id, s.d2.id].sort());
    const asc = await searchDocuments(db, s.owner, s.companyId, q({ sort: "amount_asc" }));
    const ascTotals = asc.documents.filter((d) => d.grossTotal).map((d) => Number(d.grossTotal));
    expect(ascTotals).toEqual([...ascTotals].sort((x, y) => x - y));
  });

  it("pages on the server with the total count; a page past the end still reports it", async () => {
    const c = await newCompany();
    const count = DOCUMENT_PAGE_SIZE + 3;
    for (let i = 0; i < count; i++)
      await createDraft(
        db,
        c.owner,
        c.companyId,
        input(c.cats, {
          buyer: { name: `Lapa ${i}` },
          issueDate: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`,
        }),
      );
    const page1 = await searchDocuments(db, c.owner, c.companyId, q());
    const page2 = await searchDocuments(db, c.owner, c.companyId, q({ page: "2" }));
    expect(page1.total).toBe(count);
    expect(page1.documents).toHaveLength(DOCUMENT_PAGE_SIZE);
    expect(page2).toMatchObject({ total: count });
    expect(page2.documents).toHaveLength(3);
    // No row is repeated or skipped across pages.
    const all = new Set([...ids(page1), ...ids(page2)]);
    expect(all.size).toBe(count);
    expect(await searchDocuments(db, c.owner, c.companyId, q({ page: "9" }))).toEqual({
      documents: [],
      total: count,
    });
  });

  it("never returns another company's documents, even when the search matches them", async () => {
    const s = await seeded();
    const other = await newCompany();
    const foreign = await createDraft(
      db,
      other.owner,
      other.companyId,
      input(other.cats, { buyer: { name: "Alfa Kurpes SIA" } }),
    );
    const found = await searchDocuments(db, s.owner, s.companyId, q({ q: "alfa" }));
    expect(ids(found)).not.toContain(foreign.id);
    expect(found.total).toBe(2);
    // Another company's owner cannot search this company at all.
    await expect(searchDocuments(db, other.owner, s.companyId, q())).rejects.toThrow(
      ForbiddenError,
    );
  });

  it("access: documents.view roles only; 2FA for owners; the page data maps refusals to 404", async () => {
    const s = await seeded();
    const warehouse = await member(s.companyId, "warehouse_employee");
    const production = await member(s.companyId, "production_employee");
    const stranger = actorOf((await newUser()).id);
    expect((await searchDocuments(db, warehouse, s.companyId, q())).total).toBe(5);
    await expect(searchDocuments(db, production, s.companyId, q())).rejects.toThrow(ForbiddenError);
    await expect(searchDocuments(db, stranger, s.companyId, q())).rejects.toThrow(ForbiddenError);
    await expect(
      searchDocuments(db, { ...s.owner, twoFactorVerified: false }, s.companyId, q()),
    ).rejects.toThrow(TwoFactorRequiredError);

    expect(await documentsListData(pageUser(production), s.companyId, q())).toEqual({
      status: "not_found",
    });
    const list = await documentsListData(pageUser(s.owner), s.companyId, q({ status: "draft" }));
    expect(list).toMatchObject({ status: "ok", total: 2 });
    // The default query (used by other callers) still lists everything, newest first.
    expect(await documentsListData(pageUser(s.owner), s.companyId)).toMatchObject({ total: 5 });
    expect(EMPTY_DOCUMENT_QUERY.sort).toBe("date_desc");
  });
});

describe("invoice ↔ credit note", () => {
  async function invoiceWithNotes() {
    const c = await newCompany();
    const draft = await createDraft(db, c.owner, c.companyId, input(c.cats));
    const invoice = await issueDocument(db, c.owner, c.companyId, draft.id, 1);
    const lineId = invoice.draft.lines[0]!.id;
    const issued = await createCreditNoteDraft(
      db,
      c.owner,
      c.companyId,
      invoice.id,
      [{ sourceLineId: lineId, quantity: "1" }],
      { issueDate: "2026-03-10" },
    );
    const issuedNote = await issueDocument(db, c.owner, c.companyId, issued.id, 1);
    const draftNote = await createCreditNoteDraft(
      db,
      c.owner,
      c.companyId,
      invoice.id,
      [{ sourceLineId: lineId, quantity: "2" }],
      { issueDate: "2026-03-12" },
    );
    return { ...c, invoice, issuedNote, draftNote };
  }

  it("lists an invoice's credit notes, issued first, drafts after; nothing else", async () => {
    const s = await invoiceWithNotes();
    const otherInvoice = await issueDocument(
      db,
      s.owner,
      s.companyId,
      (await createDraft(db, s.owner, s.companyId, input(s.cats))).id,
      1,
    );
    const notes = await listRelatedDocuments(db, s.owner, s.companyId, s.invoice.id, "credits");
    expect(notes).toEqual([
      expect.objectContaining({
        id: s.issuedNote.id,
        type: "credit_note",
        status: "issued",
        number: "CN-2026-0001",
        issueDate: "2026-03-10",
        grossTotal: expect.stringMatching(/^-/),
      }),
      expect.objectContaining({
        id: s.draftNote.id,
        status: "draft",
        number: null,
        grossTotal: null,
      }),
    ]);
    expect(
      await listRelatedDocuments(db, s.owner, s.companyId, otherInvoice.id, "credits"),
    ).toEqual([]);
    // Another relation kind of the same invoice is not a credit note.
    expect(await listRelatedDocuments(db, s.owner, s.companyId, s.invoice.id, "delivers")).toEqual(
      [],
    );
  });

  it("is company-scoped and needs documents.view", async () => {
    const s = await invoiceWithNotes();
    const other = await newCompany();
    // Another company asking about this invoice through its own company id gets nothing.
    expect(
      await listRelatedDocuments(db, other.owner, other.companyId, s.invoice.id, "credits"),
    ).toEqual([]);
    await expect(
      listRelatedDocuments(db, other.owner, s.companyId, s.invoice.id, "credits"),
    ).rejects.toThrow(ForbiddenError);
    const production = await member(s.companyId, "production_employee");
    await expect(
      listRelatedDocuments(db, production, s.companyId, s.invoice.id, "credits"),
    ).rejects.toThrow(ForbiddenError);
    const warehouse = await member(s.companyId, "warehouse_employee");
    expect(
      await listRelatedDocuments(db, warehouse, s.companyId, s.invoice.id, "credits"),
    ).toHaveLength(2);
  });

  it("page data: credit notes on issued invoices only; credit notes carry their invoice link", async () => {
    const s = await invoiceWithNotes();
    const page = await documentPageData(pageUser(s.owner), s.companyId, s.invoice.id);
    expect(page).toMatchObject({ status: "ok", creditNotes: { status: "ok" } });
    expect(
      page.status === "ok" && page.creditNotes?.status === "ok" ? page.creditNotes.items : [],
    ).toHaveLength(2);

    for (const id of [s.issuedNote.id, s.draftNote.id]) {
      const note = await documentPageData(pageUser(s.owner), s.companyId, id);
      expect(note).toMatchObject({
        status: "ok",
        creditNotes: null,
        document: {
          draft: {
            relation: {
              kind: "credits",
              documentId: s.invoice.id,
              documentNumber: "INV-2026-0001",
              issueDate: s.invoice.draft.issueDate,
            },
          },
        },
      });
    }
    // A draft invoice has no credit-note section.
    const draft = await createDraft(db, s.owner, s.companyId, input(s.cats));
    expect(await documentPageData(pageUser(s.owner), s.companyId, draft.id)).toMatchObject({
      status: "ok",
      creditNotes: null,
    });
  });

  it("a failure loading the credit notes keeps the invoice page usable", async () => {
    const s = await invoiceWithNotes();
    state.failRelated = true;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const page = await documentPageData(pageUser(s.owner), s.companyId, s.invoice.id);
    expect(page).toMatchObject({
      status: "ok",
      document: { id: s.invoice.id },
      creditNotes: { status: "error" },
    });
    // Only the error class is logged, never its message or document data.
    expect(errors.mock.calls.flat().join(" ")).not.toContain("simulated database outage");
    errors.mockRestore();
  });

  it("the stored relation is the only link: rows point to the invoice by id in the same company", async () => {
    const s = await invoiceWithNotes();
    const [row] = await db.select().from(documents).where(eq(documents.id, s.issuedNote.id));
    expect(row).toMatchObject({
      companyId: s.companyId,
      relatedDocumentId: s.invoice.id,
      relationKind: "credits",
    });
  });
});
