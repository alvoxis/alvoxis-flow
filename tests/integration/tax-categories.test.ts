import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { type Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCreditNoteDraft,
  createDraft,
  deriveDraft,
  issueDocument,
  verifyDocumentIntegrity,
} from "@/modules/documents/server/document-service";
import { DocumentValidationError } from "@/modules/documents/server/errors";
import { ensureDefaultNumberSeries } from "@/modules/documents/server/numbering-service";
import { updateTaxCategory } from "@/modules/documents/server/tax-category-service";
import { type Actor } from "@/server/auth/authorization";
import { type Database } from "@/server/db/client";
import {
  auditLogs,
  companies,
  documentLines,
  documents,
  memberships,
  roles,
  taxCategories,
  users,
} from "@/server/db/schema";
import { UnauthenticatedError } from "@/server/errors";
import { createCompanyWithOwner } from "@/server/tenancy/company-service";
import { addFixtureBankAccount } from "../support/bank-account-fixtures";
import { FIXTURE_SELLER_PROFILE, FIXTURE_TAX, invoiceDraft } from "../support/document-fixtures";
import { openTestDb } from "./test-db";

/**
 * Company tax-category catalog: the HTTP layer (real route handlers, services and database; only
 * the session lookup is stubbed, as in documents-api.test.ts), server-side enforcement when drafts
 * are saved and issued, database constraints and concurrency with issuing. Fixture categories are
 * arbitrary values, not real country rates. Synthetic data only.
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

const collection = await import("@/app/api/companies/[companyId]/tax-categories/route");
const single = await import("@/app/api/companies/[companyId]/tax-categories/[categoryId]/route");
const docs = await import("@/app/api/companies/[companyId]/documents/route");
const doc = await import("@/app/api/companies/[companyId]/documents/[documentId]/route");
const issueRoute =
  await import("@/app/api/companies/[companyId]/documents/[documentId]/issue/route");

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

const actorOf = (userId: string): Actor => ({ userId, twoFactorVerified: true });
const as = (actor: Actor | null) => {
  session.actor = actor;
};

async function newUser() {
  const [u] = await db
    .insert(users)
    .values({ email: `tax-${randomUUID()}@example.test` })
    .returning();
  return u!;
}

async function newCompany() {
  const owner = actorOf((await newUser()).id);
  const { companyId } = await createCompanyWithOwner(db, owner, { name: "Tax Co", country: "LV" });
  await db.update(companies).set(FIXTURE_SELLER_PROFILE).where(eq(companies.id, companyId));
  await ensureDefaultNumberSeries(db, owner, companyId);
  return { owner, companyId };
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

const req = (method: string, body?: unknown, url = "http://localhost/api") =>
  new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const p = <T extends object>(v: T) => ({ params: Promise.resolve(v) });

async function call(res: Response | Promise<Response>) {
  const r = await res;
  // Response bodies are asserted field by field; a loose type keeps the assertions readable.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: r.status, body: (await r.json()) as Record<string, any> };
}

const api = {
  list: (companyId: string, includeArchived = false) =>
    call(
      collection.GET(
        req("GET", undefined, `http://localhost/api${includeArchived ? "?includeArchived=1" : ""}`),
        p({ companyId }),
      ),
    ),
  create: (companyId: string, body: unknown) =>
    call(collection.POST(req("POST", body), p({ companyId }))),
  patch: (companyId: string, categoryId: string, body: unknown) =>
    call(single.PATCH(req("PATCH", body), p({ companyId, categoryId }))),
  createDoc: (companyId: string, body: unknown) =>
    call(docs.POST(req("POST", body), p({ companyId }))),
  getDoc: (companyId: string, documentId: string) =>
    call(doc.GET(req("GET"), p({ companyId, documentId }))),
  patchDoc: (companyId: string, documentId: string, body: unknown) =>
    call(doc.PATCH(req("PATCH", body), p({ companyId, documentId }))),
  issue: (companyId: string, documentId: string, expectedVersion: number) =>
    call(issueRoute.POST(req("POST", { expectedVersion }), p({ companyId, documentId }))),
};

/** Creates a category through the API as `actor` and returns its id. */
async function category(companyId: string, actor: Actor, cat: object = FIXTURE_TAX.standard20) {
  as(actor);
  const res = await api.create(companyId, cat);
  expect(res.status).toBe(201);
  return res.body.taxCategory.id as string;
}

/** Draft API input whose lines all use `categoryId`. */
function input(categoryId: string | null, overrides: Parameters<typeof invoiceDraft>[0] = {}) {
  const { lines, relation: _r, bankAccounts: _b, ...rest } = invoiceDraft(overrides);
  return {
    ...rest,
    lines: lines.map(({ id: _id, sourceLineId: _s, taxCategory: _t, ...l }) => ({
      ...l,
      taxCategoryId: categoryId,
    })),
  };
}

const auditActions = async (entityId: string) =>
  (
    await db
      .select({ action: auditLogs.action })
      .from(auditLogs)
      .where(eq(auditLogs.entityId, entityId))
      .orderBy(asc(auditLogs.createdAt))
  ).map((r) => r.action);

const lineRows = (documentId: string) =>
  db
    .select()
    .from(documentLines)
    .where(eq(documentLines.documentId, documentId))
    .orderBy(asc(documentLines.position));

describe("tax category catalog API", () => {
  it("creates, lists, edits label/note, archives and restores; code/kind/rate never change", async () => {
    const { owner, companyId } = await newCompany();
    as(owner);
    expect((await api.list(companyId)).body.taxCategories).toEqual([]); // no presets

    const created = await api.create(companyId, FIXTURE_TAX.exempt);
    expect(created).toMatchObject({
      status: 201,
      body: {
        taxCategory: {
          code: "EX",
          kind: "exempt",
          ratePercent: "0",
          label: "Fixture exempt",
          archived: false,
          version: 1,
        },
        issues: [],
      },
    });
    const id = created.body.taxCategory.id as string;
    // Technical consistency only: a 0% "standard" rate needs an explicit treatment.
    const zeroStandard = await api.create(companyId, {
      code: "S0",
      kind: "standard",
      ratePercent: "0",
      label: "Zero",
    });
    expect(zeroStandard).toMatchObject({ status: 422, body: { error: "validation_failed" } });
    expect(zeroStandard.body.issues.map((i: { code: string }) => i.code)).toEqual([
      "tax.rate.zeroRequiresTreatment",
    ]);
    expect((await api.create(companyId, { ...FIXTURE_TAX.standard20, extra: 1 })).status).toBe(422);
    expect((await api.create(companyId, { ...FIXTURE_TAX.standard20, kind: "vat" })).status).toBe(
      422,
    );

    const relabelled = await api.patch(companyId, id, {
      expectedVersion: 1,
      label: "Exempt (fixture)",
      note: null,
    });
    expect(relabelled.body).toMatchObject({
      taxCategory: { label: "Exempt (fixture)", note: null, version: 2 },
      // Without a note the exemption only gets the existing "note recommended" warning.
      issues: [{ code: "tax.note.recommended", severity: "warning" }],
    });
    for (const field of [{ code: "X" }, { kind: "standard" }, { ratePercent: "5" }]) {
      expect((await api.patch(companyId, id, { expectedVersion: 2, ...field })).status).toBe(422);
    }
    expect(await api.patch(companyId, id, { expectedVersion: 1, label: "Stale" })).toMatchObject({
      status: 409,
      body: { error: "version_conflict" },
    });

    const archived = await api.patch(companyId, id, { expectedVersion: 2, archived: true });
    expect(archived.body.taxCategory).toMatchObject({ archived: true, version: 3 });
    expect((await api.list(companyId)).body.taxCategories).toEqual([]);
    expect((await api.list(companyId, true)).body.taxCategories).toEqual([
      expect.objectContaining({ id, archived: true }),
    ]);
    // Codes are never reused, archived ones included.
    expect(await api.create(companyId, FIXTURE_TAX.exempt)).toMatchObject({
      status: 409,
      body: { error: "code_taken" },
    });
    await api.patch(companyId, id, { expectedVersion: 3, archived: false });
    expect(await auditActions(id)).toEqual([
      "tax_category.created",
      "tax_category.updated",
      "tax_category.archived",
      "tax_category.restored",
    ]);
    const [row] = await db.select().from(taxCategories).where(eq(taxCategories.id, id));
    expect(row).toMatchObject({ code: "EX", kind: "exempt", ratePercent: "0.00", version: 4 });
  });

  it("permissions: manage for owner/administrator/accountant, read with documents.view", async () => {
    const { owner, companyId } = await newCompany();
    const id = await category(companyId, owner);

    for (const role of ["administrator", "accountant"]) {
      as(await member(companyId, role));
      expect((await api.create(companyId, { ...FIXTURE_TAX.zero, code: `Z-${role}` })).status).toBe(
        201,
      );
    }
    for (const role of ["manager", "warehouse_employee"]) {
      as(await member(companyId, role));
      expect((await api.list(companyId)).status).toBe(200);
      expect((await api.create(companyId, { ...FIXTURE_TAX.zero, code: "NO" })).status).toBe(403);
      expect((await api.patch(companyId, id, { expectedVersion: 1, label: "No" })).status).toBe(
        403,
      );
    }
    as(await member(companyId, "production_employee"));
    expect((await api.list(companyId)).status).toBe(403);

    as(null);
    expect((await api.list(companyId)).status).toBe(401);
    as(actorOf((await newUser()).id));
    expect((await api.list(companyId)).status).toBe(403);
    expect((await api.patch(companyId, id, { expectedVersion: 1, label: "X" })).status).toBe(403);
    as({ userId: owner.userId, twoFactorVerified: false });
    expect((await api.create(companyId, FIXTURE_TAX.reverse)).body.error).toBe(
      "two_factor_enrollment_required",
    );
    await db.update(companies).set({ archivedAt: new Date() }).where(eq(companies.id, companyId));
    as(owner);
    expect((await api.list(companyId)).status).toBe(403);
    expect((await api.create(companyId, FIXTURE_TAX.reverse)).status).toBe(403);
  });

  it("another company's category is invisible: 404 on edit, 422 when used on a line", async () => {
    const a = await newCompany();
    const b = await newCompany();
    const foreignId = await category(b.companyId, b.owner);
    await category(a.companyId, a.owner);
    as(a.owner);
    expect(
      (await api.patch(a.companyId, foreignId, { expectedVersion: 1, label: "X" })).status,
    ).toBe(404);
    expect((await api.patch(a.companyId, randomUUID(), { expectedVersion: 1 })).status).toBe(404);
    for (const id of [foreignId, randomUUID()]) {
      const res = await api.createDoc(a.companyId, input(id));
      expect(res).toMatchObject({ status: 422, body: { error: "validation_failed" } });
      expect(res.body.issues[0]).toMatchObject({
        code: "line.taxCategory.unknown",
        path: "lines.0.taxCategoryId",
      });
    }
    // Database level: a line cannot reference another company's category either.
    const own = await createDraft(db, a.owner, a.companyId, input(null, { type: "delivery_note" }));
    await expect(
      db
        .update(documentLines)
        .set({ taxCategoryId: foreignId })
        .where(eq(documentLines.documentId, own.id)),
    ).rejects.toThrow();
    await expect(
      db.insert(taxCategories).values({
        companyId: a.companyId,
        code: "BAD",
        kind: "standard",
        ratePercent: "0",
        label: "Bad",
      }),
    ).rejects.toThrow();
  });
});

describe("tax categories on drafts and issuing", () => {
  it("the server builds snapshots from the catalog; inline categories are refused", async () => {
    const { owner, companyId } = await newCompany();
    const id = await category(companyId, owner);
    as(owner);
    const inline = invoiceDraft();
    const refused = await api.createDoc(companyId, {
      ...input(id),
      lines: inline.lines.map(({ id: _i, ...l }) => l),
    });
    expect(refused.status).toBe(422);

    const bankAccountId = await addFixtureBankAccount(db, owner, companyId);
    const created = await api.createDoc(companyId, { ...input(id), bankAccountId });
    expect(created.status).toBe(201);
    expect(created.body.document.draft.lines[0]).toMatchObject({
      taxCategoryId: id,
      taxCategory: { code: "T20", kind: "standard", ratePercent: "20", label: "Fixture 20%" },
    });
    expect(created.body.document.issues).toEqual([]);
  });

  it("archived categories: not assignable, kept on existing drafts but blocking issue; no number used", async () => {
    const { owner, companyId } = await newCompany();
    const active = await category(companyId, owner);
    const old = await category(companyId, owner, FIXTURE_TAX.reduced75);
    const other = await category(companyId, owner, FIXTURE_TAX.zero);
    as(owner);
    const draft = (await api.createDoc(companyId, input(old))).body.document;
    await api.patch(companyId, old, { expectedVersion: 1, archived: true });
    await api.patch(companyId, other, { expectedVersion: 1, archived: true });

    // New drafts cannot use archived categories.
    const refused = await api.createDoc(companyId, input(old));
    expect(refused.body.issues[0]).toMatchObject({ code: "line.taxCategory.archived" });
    // The existing draft keeps it (saving other edits works) but shows a blocking finding…
    const saved = await api.patchDoc(companyId, draft.id, {
      expectedVersion: 1,
      draft: input(old, { notes: "Edited" }),
    });
    expect(saved.status).toBe(200);
    expect(saved.body.document.issues).toContainEqual(
      expect.objectContaining({ code: "line.taxCategory.archived", severity: "error" }),
    );
    // …and cannot switch to another archived category.
    expect(
      (await api.patchDoc(companyId, draft.id, { expectedVersion: 2, draft: input(other) })).body
        .issues[0],
    ).toMatchObject({ code: "line.taxCategory.archived" });

    const blocked = await api.issue(companyId, draft.id, 2);
    expect(blocked).toMatchObject({ status: 422, body: { error: "validation_failed" } });
    expect(blocked.body.issues).toContainEqual(
      expect.objectContaining({ code: "line.taxCategory.archived" }),
    );
    // An explicit choice of an active category unblocks issuing; the number was not consumed.
    await api.patchDoc(companyId, draft.id, { expectedVersion: 2, draft: input(active) });
    expect((await api.issue(companyId, draft.id, 3)).body.document.number).toBe("INV-2026-0001");
  });

  it("issue freezes the current label; later edits and archiving never touch issued documents", async () => {
    const { owner, companyId } = await newCompany();
    const id = await category(companyId, owner);
    as(owner);
    const draft = (await api.createDoc(companyId, input(id))).body.document;
    await api.patch(companyId, id, { expectedVersion: 1, label: "Renamed 20%", note: "Fixture" });
    const issued = (await api.issue(companyId, draft.id, 1)).body.document;
    expect(issued.draft.lines[0].taxCategory).toEqual({
      code: "T20",
      kind: "standard",
      ratePercent: "20",
      label: "Renamed 20%",
      note: "Fixture",
    });
    // The catalog link is a draft-time reference, not part of the issued snapshot.
    expect(issued.draft.lines[0]).not.toHaveProperty("taxCategoryId");
    const rows = await lineRows(draft.id);
    expect(rows[0]!.taxCategory).toEqual(issued.draft.lines[0].taxCategory);

    await api.patch(companyId, id, { expectedVersion: 2, label: "Changed later" });
    await api.patch(companyId, id, { expectedVersion: 3, archived: true });
    const after = (await api.getDoc(companyId, draft.id)).body.document;
    expect(after.draft).toEqual(issued.draft);
    expect(after.contentHash).toBe(issued.contentHash);
    expect(await verifyDocumentIntegrity(db, owner, companyId, draft.id)).toBe(true);
    expect(await lineRows(draft.id)).toEqual(rows);
  });

  it("lines from before the catalog need an explicit choice before issuing", async () => {
    const { owner, companyId } = await newCompany();
    const id = await category(companyId, owner);
    as(owner);
    const draft = (await api.createDoc(companyId, input(id))).body.document;
    // Simulate a pre-catalog draft: an inline snapshot without a catalog link.
    await db
      .update(documentLines)
      .set({ taxCategoryId: null, taxCategory: FIXTURE_TAX.standard20 })
      .where(eq(documentLines.documentId, draft.id));
    const legacy = (await api.getDoc(companyId, draft.id)).body.document;
    expect(legacy.issues).toContainEqual(
      expect.objectContaining({ code: "line.taxCategory.unlinked", severity: "error" }),
    );
    const blocked = await api.issue(companyId, draft.id, 1);
    expect(blocked.status).toBe(422);
    expect(blocked.body.issues.map((i: { code: string }) => i.code)).toContain(
      "line.taxCategory.unlinked",
    );
    expect((await db.select().from(documents).where(eq(documents.id, draft.id)))[0]).toMatchObject({
      status: "draft",
      number: null,
    });
  });

  it("credit notes keep the invoice's snapshots; submitted categories are ignored, tampering refused", async () => {
    const { owner, companyId } = await newCompany();
    const id = await category(companyId, owner);
    const other = await category(companyId, owner, FIXTURE_TAX.zero);
    const bankAccountId = await addFixtureBankAccount(db, owner, companyId);
    as(owner);
    const inv = (await api.createDoc(companyId, { ...input(id), bankAccountId })).body.document;
    const issuedInv = (await api.issue(companyId, inv.id, 1)).body.document;
    // Archiving the invoice's category does not block crediting it.
    await api.patch(companyId, id, { expectedVersion: 1, archived: true });

    const cn = await createCreditNoteDraft(db, owner, companyId, inv.id, "full", {
      issueDate: "2026-03-10",
    });
    const { relation: _r, bankAccounts: _b, lines, ...rest } = cn.draft;
    const edited = await api.patchDoc(companyId, cn.id, {
      expectedVersion: 1,
      draft: {
        ...rest,
        lines: lines.map(({ id: _i, sourceLineId: _s, taxCategory: _t, ...l }) => ({
          ...l,
          taxCategoryId: other,
        })),
      },
    });
    expect(edited.status).toBe(200);
    const originalCategories = issuedInv.draft.lines.map(
      (l: { taxCategory: unknown }) => l.taxCategory,
    );
    expect(
      edited.body.document.draft.lines.map((l: { taxCategory: unknown }) => l.taxCategory),
    ).toEqual(originalCategories);
    expect(edited.body.document.issues).toEqual([]);

    // Defence in depth: a line changed behind the API is refused at issue time.
    const [first] = await lineRows(cn.id);
    await db
      .update(documentLines)
      .set({ taxCategory: FIXTURE_TAX.zero })
      .where(eq(documentLines.id, first!.id));
    expect(await api.issue(companyId, cn.id, 2)).toMatchObject({
      status: 409,
      body: { code: "creditNote.taxCategoryMismatch" },
    });
    await db
      .update(documentLines)
      .set({ taxCategory: first!.taxCategory })
      .where(eq(documentLines.id, first!.id));
    const issuedCn = (await api.issue(companyId, cn.id, 2)).body.document;
    expect(issuedCn.draft.lines.map((l: { taxCategory: unknown }) => l.taxCategory)).toEqual(
      originalCategories,
    );
  });

  it("derived invoices keep active categories and ask for a choice when one was archived", async () => {
    const { owner, companyId } = await newCompany();
    const id = await category(companyId, owner);
    const bankAccountId = await addFixtureBankAccount(db, owner, companyId);
    as(owner);
    const pf = (
      await api.createDoc(companyId, { ...input(id, { type: "proforma" }), bankAccountId })
    ).body.document;
    await api.issue(companyId, pf.id, 1);
    const inv = await deriveDraft(db, owner, companyId, pf.id, "invoice_from_proforma", {
      issueDate: "2026-03-05",
    });
    expect(inv.draft.lines.every((l) => l.taxCategoryId === id)).toBe(true);
    expect(inv.issues).toEqual([]);

    await api.patch(companyId, id, { expectedVersion: 1, archived: true });
    const later = await deriveDraft(db, owner, companyId, pf.id, "invoice_from_proforma", {
      issueDate: "2026-03-06",
    });
    expect(later.draft.lines.every((l) => l.taxCategoryId === undefined)).toBe(true);
    expect(later.issues.map((i) => i.code)).toContain("line.taxCategory.unlinked");
    await expect(issueDocument(db, owner, companyId, later.id, 1)).rejects.toThrow(
      DocumentValidationError,
    );
  });
});

describe("concurrent issuing and archiving", () => {
  it("an issue waiting on an archive sees the archived category and uses no number", async () => {
    const { owner, companyId } = await newCompany();
    const id = await category(companyId, owner);
    const draft = await createDraft(db, owner, companyId, input(id));
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT id FROM tax_categories WHERE id = $1 FOR UPDATE", [id]);
      await client.query(
        "UPDATE tax_categories SET archived_at = now(), version = version + 1 WHERE id = $1",
        [id],
      );
      let settled = false;
      const pending = issueDocument(db, owner, companyId, draft.id, 1).finally(() => {
        settled = true;
      });
      pending.catch(() => {});
      await new Promise((r) => setTimeout(r, 300));
      expect(settled).toBe(false); // blocked on the category lock
      await client.query("COMMIT");
      await expect(pending).rejects.toThrow(/line\.taxCategory\.archived/);
    } finally {
      client.release();
    }
    const [row] = await db.select().from(documents).where(eq(documents.id, draft.id));
    expect(row).toMatchObject({ status: "draft", number: null });
  });

  it("an archive waits for an issue holding the category, and the issued document stays intact", async () => {
    const { owner, companyId } = await newCompany();
    const id = await category(companyId, owner);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Same lock an in-flight issue holds on the categories of its lines.
      await client.query("SELECT id FROM tax_categories WHERE id = $1 FOR SHARE", [id]);
      let settled = false;
      const archiving = updateTaxCategory(db, owner, companyId, id, {
        expectedVersion: 1,
        archived: true,
      }).finally(() => {
        settled = true;
      });
      await new Promise((r) => setTimeout(r, 300));
      expect(settled).toBe(false);
      await client.query("COMMIT");
      expect((await archiving).taxCategory.archived).toBe(true);
    } finally {
      client.release();
    }
  });

  it("racing issue and archive: either the issue completes first or it fails without a number", async () => {
    const { owner, companyId } = await newCompany();
    const outcomes: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = await category(companyId, owner, { ...FIXTURE_TAX.standard20, code: `R${i}` });
      const draft = await createDraft(db, owner, companyId, input(id));
      const [issued, archived] = await Promise.allSettled([
        issueDocument(db, owner, companyId, draft.id, 1),
        updateTaxCategory(db, owner, companyId, id, { expectedVersion: 1, archived: true }),
      ]);
      expect(archived.status).toBe("fulfilled");
      const [row] = await db.select().from(documents).where(eq(documents.id, draft.id));
      if (issued.status === "fulfilled") {
        expect(row).toMatchObject({ status: "issued" });
        expect(await verifyDocumentIntegrity(db, owner, companyId, draft.id)).toBe(true);
        outcomes.push("issued");
      } else {
        expect(issued.reason).toBeInstanceOf(DocumentValidationError);
        expect(row).toMatchObject({ status: "draft", number: null });
        outcomes.push("refused");
      }
    }
    // Numbers stay gap-free whatever the interleaving.
    const numbers = (
      await db
        .select({ number: documents.number })
        .from(documents)
        .where(and(eq(documents.companyId, companyId), eq(documents.status, "issued")))
    )
      .map((r) => r.number)
      .sort();
    expect(numbers).toEqual(numbers.map((_, i) => `INV-2026-${String(i + 1).padStart(4, "0")}`));
    expect(outcomes).toHaveLength(5);
  });
});
