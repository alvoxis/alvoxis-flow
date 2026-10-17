import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { type Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyDocumentIntegrity } from "@/modules/documents/server/document-service";
import { ensureDefaultNumberSeries } from "@/modules/documents/server/numbering-service";
import { type Actor } from "@/server/auth/authorization";
import { type Database } from "@/server/db/client";
import { auditLogs, companies, documents, memberships, roles, users } from "@/server/db/schema";
import { UnauthenticatedError } from "@/server/errors";
import { createCompanyWithOwner } from "@/server/tenancy/company-service";
import { FIXTURE_SELLER_PROFILE, invoiceDraft } from "../support/document-fixtures";
import {
  addFixtureTaxCategories,
  withCategoryIds,
  type FixtureCategoryIds,
} from "../support/tax-category-fixtures";
import { openTestDb } from "./test-db";

/**
 * HTTP layer of the document API: the real route handlers, services and database. Only the
 * session lookup is stubbed (it is covered by the auth tests); the actor's 2FA state is set per
 * test exactly as `requireUser` would derive it from the session. Synthetic data only.
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

const collection = await import("@/app/api/companies/[companyId]/documents/route");
const single = await import("@/app/api/companies/[companyId]/documents/[documentId]/route");
const issueRoute =
  await import("@/app/api/companies/[companyId]/documents/[documentId]/issue/route");
const creditNoteRoute =
  await import("@/app/api/companies/[companyId]/documents/[documentId]/credit-note/route");

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
    .values({ email: `docs-api-${randomUUID()}@example.test` })
    .returning();
  return u!;
}

/** Catalog of the most recently created company (inputs reference it by id). */
let cats: FixtureCategoryIds = {};

async function newCompany() {
  const owner = actorOf((await newUser()).id);
  const { companyId } = await createCompanyWithOwner(db, owner, { name: "Api Co", country: "LV" });
  await db.update(companies).set(FIXTURE_SELLER_PROFILE).where(eq(companies.id, companyId));
  await ensureDefaultNumberSeries(db, owner, companyId);
  cats = await addFixtureTaxCategories(db, owner, companyId);
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

function input(overrides: Parameters<typeof invoiceDraft>[0] = {}) {
  const { lines, relation: _r, bankAccounts: _b, ...rest } = invoiceDraft(overrides);
  return {
    ...rest,
    lines: withCategoryIds(
      lines.map(({ id: _id, sourceLineId: _s, ...l }) => l),
      cats,
    ),
  };
}

const req = (method: string, body?: unknown) =>
  new Request("http://localhost/api", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
const p = <T extends object>(v: T) => ({ params: Promise.resolve(v) });

async function call(res: Response | Promise<Response>) {
  const r = await res;
  // Response bodies are asserted field by field; a loose type keeps the assertions readable.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: r.status, body: (await r.json()) as Record<string, any> };
}

const api = {
  create: (companyId: string, body: unknown) =>
    call(collection.POST(req("POST", body), p({ companyId }))),
  list: (companyId: string) => call(collection.GET(req("GET"), p({ companyId }))),
  get: (companyId: string, documentId: string) =>
    call(single.GET(req("GET"), p({ companyId, documentId }))),
  patch: (companyId: string, documentId: string, body: unknown) =>
    call(single.PATCH(req("PATCH", body), p({ companyId, documentId }))),
  remove: (companyId: string, documentId: string) =>
    call(single.DELETE(req("DELETE"), p({ companyId, documentId }))),
  issue: (companyId: string, documentId: string, body: unknown) =>
    call(issueRoute.POST(req("POST", body), p({ companyId, documentId }))),
  creditNote: (companyId: string, documentId: string, body: unknown) =>
    call(creditNoteRoute.POST(req("POST", body), p({ companyId, documentId }))),
};

async function storedRow(id: string) {
  const [row] = await db.select().from(documents).where(eq(documents.id, id));
  return row;
}

async function auditActions(documentId: string) {
  const rows = await db
    .select({ action: auditLogs.action })
    .from(auditLogs)
    .where(eq(auditLogs.entityId, documentId))
    .orderBy(asc(auditLogs.createdAt));
  return rows.map((r) => r.action);
}

describe("document API: draft → validation → issue", () => {
  it("creates, edits and issues a draft; the issued snapshot is frozen and audited", async () => {
    const { owner, companyId } = await newCompany();
    as(owner);

    const created = await api.create(companyId, input({ seller: { name: "Client-chosen SIA" } }));
    expect(created.status).toBe(201);
    const doc = created.body.document;
    expect(doc).toMatchObject({ status: "draft", number: null, version: 1 });
    expect(doc.draft.seller.name).toBe("Example Workwear SIA"); // from the profile, not the client

    expect((await api.get(companyId, doc.id)).body.document).toMatchObject({ id: doc.id });

    const edited = await api.patch(companyId, doc.id, {
      expectedVersion: 1,
      draft: input({ notes: "Edited via API" }),
    });
    expect(edited.status).toBe(200);
    expect(edited.body.document).toMatchObject({ version: 2, draft: { notes: "Edited via API" } });

    const issued = await api.issue(companyId, doc.id, { expectedVersion: 2 });
    expect(issued.status).toBe(200);
    expect(issued.body.document).toMatchObject({
      status: "issued",
      number: "INV-2026-0001",
      draft: { notes: "Edited via API", seller: { name: "Example Workwear SIA" } },
    });
    expect(issued.body.document.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await verifyDocumentIntegrity(db, owner, companyId, doc.id)).toBe(true);

    // Issued documents are read from the snapshot and can no longer be edited or deleted.
    await db.update(companies).set({ legalName: "Renamed SIA" }).where(eq(companies.id, companyId));
    const read = await api.get(companyId, doc.id);
    expect(read.body.document.draft.seller.name).toBe("Example Workwear SIA");
    expect(
      await api.patch(companyId, doc.id, { expectedVersion: 2, draft: input() }),
    ).toMatchObject({ status: 409, body: { error: "invalid_state", code: "document.notDraft" } });
    expect(await api.remove(companyId, doc.id)).toMatchObject({
      status: 409,
      body: { code: "document.notDraft" },
    });

    expect(await auditActions(doc.id)).toEqual([
      "document.draft_created",
      "document.draft_updated",
      "document.issued",
    ]);
    const list = await api.list(companyId);
    expect(list.body.documents).toEqual([
      expect.objectContaining({ id: doc.id, status: "issued", number: "INV-2026-0001" }),
    ]);
  });

  it("a stale expectedVersion is a 409 conflict and changes nothing", async () => {
    const { owner, companyId } = await newCompany();
    as(owner);
    const { id } = (await api.create(companyId, input())).body.document;
    expect((await api.patch(companyId, id, { expectedVersion: 1, draft: input() })).status).toBe(
      200,
    );
    const stale = await api.patch(companyId, id, {
      expectedVersion: 1,
      draft: input({ notes: "lost update" }),
    });
    expect(stale).toMatchObject({ status: 409, body: { error: "version_conflict" } });
    expect(await api.issue(companyId, id, { expectedVersion: 1 })).toMatchObject({
      status: 409,
      body: { error: "version_conflict" },
    });
    const row = await storedRow(id);
    expect(row).toMatchObject({ version: 2, status: "draft", number: null });
    expect(row!.notes).not.toBe("lost update");
  });

  it("issuing twice returns 409 and never allocates another number", async () => {
    const { owner, companyId } = await newCompany();
    as(owner);
    const { id } = (await api.create(companyId, input())).body.document;
    const first = await api.issue(companyId, id, { expectedVersion: 1 });
    expect(first.body.document.number).toBe("INV-2026-0001");

    for (const expectedVersion of [1, 2]) {
      expect(await api.issue(companyId, id, { expectedVersion })).toMatchObject({
        status: 409,
        body: { error: "invalid_state", code: "document.alreadyIssued" },
      });
    }
    expect((await storedRow(id))!.number).toBe("INV-2026-0001");
    expect((await auditActions(id)).filter((a) => a === "document.issued")).toHaveLength(1);

    // The next document gets the very next number: the repeated attempts used none.
    const next = (await api.create(companyId, input())).body.document;
    expect((await api.issue(companyId, next.id, { expectedVersion: 1 })).body.document.number).toBe(
      "INV-2026-0002",
    );
  });

  it("without a seller address issuing is a 422 and uses no number", async () => {
    const { owner, companyId } = await newCompany();
    as(owner);
    await db
      .update(companies)
      .set({ addressLine1: null, addressLine2: null })
      .where(eq(companies.id, companyId));
    const created = await api.create(companyId, input());
    const { id, issues } = created.body.document;
    expect(issues).toContainEqual(expect.objectContaining({ code: "seller.address.required" }));

    const failed = await api.issue(companyId, id, { expectedVersion: 1 });
    expect(failed.status).toBe(422);
    expect(failed.body.error).toBe("validation_failed");
    expect(failed.body.issues).toContainEqual({
      code: "seller.address.required",
      severity: "error",
      path: "seller.address",
    });
    expect(await storedRow(id)).toMatchObject({ status: "draft", number: null });
    expect(await auditActions(id)).not.toContain("document.issued");

    // Once the profile has an address the same draft is issued with the first number.
    await db
      .update(companies)
      .set({ addressLine1: "Example street 1" })
      .where(eq(companies.id, companyId));
    const ok = await api.issue(companyId, id, { expectedVersion: 1 });
    expect(ok.body.document).toMatchObject({
      number: "INV-2026-0001",
      draft: { seller: { address: { lines: ["Example street 1"] } } },
    });
  });

  it("invalid input is 422, malformed requests 400, unknown documents 404", async () => {
    // `input()` uses the most recent company's catalog, so the company under test comes last.
    const other = await newCompany();
    const { owner, companyId } = await newCompany();
    as(owner);

    const bad = await api.create(companyId, { ...input(), issueDate: "02.03.2026" });
    expect(bad.status).toBe(422);
    expect(bad.body.issues).toContainEqual(expect.objectContaining({ path: "issueDate" }));
    expect(await api.create(companyId, "not json")).toMatchObject({ status: 400 });
    expect(await api.create("not-a-uuid", input())).toMatchObject({ status: 400 });

    const { id } = (await api.create(companyId, input())).body.document;
    const noVersion = await api.patch(companyId, id, { draft: input() });
    expect(noVersion.status).toBe(422);
    expect(noVersion.body.issues).toContainEqual(
      expect.objectContaining({ path: "expectedVersion" }),
    );
    const badLine = await api.patch(companyId, id, {
      expectedVersion: 1,
      draft: { ...input(), lines: [{ description: "x", quantity: "abc", unitPrice: "1" }] },
    });
    expect(badLine.status).toBe(422);
    expect((await storedRow(id))!.version).toBe(1);
    expect((await api.issue(companyId, id, {})).status).toBe(422);
    expect(await api.create(companyId, { ...input(), type: "credit_note" })).toMatchObject({
      status: 409,
      body: { code: "creditNote.useDedicatedFlow" },
    });

    expect((await api.get(companyId, randomUUID())).status).toBe(404);
    expect((await api.get(companyId, "nope")).status).toBe(400);
    // A document of another company is not found through this company's URL.
    as(other.owner);
    const ownCats = cats;
    cats = other.cats;
    const foreign = (await api.create(other.companyId, input())).body.document;
    cats = ownCats;
    as(owner);
    for (const r of [
      await api.get(companyId, foreign.id),
      await api.patch(companyId, foreign.id, { expectedVersion: 1, draft: input() }),
      await api.issue(companyId, foreign.id, { expectedVersion: 1 }),
      await api.remove(companyId, foreign.id),
    ])
      expect(r).toMatchObject({ status: 404, body: { error: "not_found" } });
    expect(await storedRow(foreign.id)).toMatchObject({ status: "draft", version: 1 });
  });

  it("deletes drafts only", async () => {
    const { owner, companyId } = await newCompany();
    as(owner);
    const { id } = (await api.create(companyId, input())).body.document;
    expect(await api.remove(companyId, id)).toMatchObject({ status: 200, body: { deleted: true } });
    expect(await storedRow(id)).toBeUndefined();
    expect((await api.get(companyId, id)).status).toBe(404);
    expect(await auditActions(id)).toEqual(["document.draft_created", "document.draft_deleted"]);
  });

  it("roles: each operation needs its own permission", async () => {
    const { owner, companyId } = await newCompany();
    as(owner);
    const { id } = (await api.create(companyId, input())).body.document;

    // Manager: create and edit, but not issue.
    as(await member(companyId, "manager"));
    const own = (await api.create(companyId, input())).body.document;
    expect(own.status).toBe("draft");
    expect((await api.patch(companyId, id, { expectedVersion: 1, draft: input() })).status).toBe(
      200,
    );
    expect(await api.issue(companyId, id, { expectedVersion: 2 })).toMatchObject({
      status: 403,
      body: { error: "forbidden" },
    });
    expect((await storedRow(id))!.number).toBeNull();

    // Accountant: may issue.
    as(await member(companyId, "accountant"));
    expect((await api.issue(companyId, id, { expectedVersion: 2 })).body.document.number).toBe(
      "INV-2026-0001",
    );

    // Warehouse employee: read only.
    as(await member(companyId, "warehouse_employee"));
    expect((await api.get(companyId, id)).status).toBe(200);
    expect((await api.list(companyId)).status).toBe(200);
    expect((await api.create(companyId, input())).status).toBe(403);
    expect(
      (await api.patch(companyId, own.id, { expectedVersion: 1, draft: input() })).status,
    ).toBe(403);
    expect((await api.remove(companyId, own.id)).status).toBe(403);
    expect((await api.issue(companyId, own.id, { expectedVersion: 1 })).status).toBe(403);

    // Production employee: no document access at all.
    as(await member(companyId, "production_employee"));
    expect((await api.get(companyId, id)).status).toBe(403);
    expect((await api.list(companyId)).status).toBe(403);
    expect(await storedRow(own.id)).toMatchObject({ status: "draft", version: 1 });
  });

  it("refuses anonymous callers, non-members, archived companies and owners without 2FA", async () => {
    const { owner, companyId } = await newCompany();
    as(owner);
    const { id } = (await api.create(companyId, input())).body.document;

    const everything = async () => [
      await api.list(companyId),
      await api.create(companyId, input()),
      await api.get(companyId, id),
      await api.patch(companyId, id, { expectedVersion: 1, draft: input() }),
      await api.issue(companyId, id, { expectedVersion: 1 }),
      await api.remove(companyId, id),
    ];
    const expectAll = async (status: number, error: string) => {
      for (const r of await everything()) expect(r).toMatchObject({ status, body: { error } });
    };

    as(null);
    await expectAll(401, "unauthenticated");
    // A non-member gets the same answer whether or not the company or document exists.
    as(actorOf((await newUser()).id));
    await expectAll(403, "forbidden");
    expect((await api.get(randomUUID(), randomUUID())).status).toBe(403);
    // Owner role requires 2FA in this session.
    as({ userId: owner.userId, twoFactorVerified: false });
    await expectAll(403, "two_factor_enrollment_required");
    // Archived companies are closed to everyone, including the owner.
    await db.update(companies).set({ archivedAt: new Date() }).where(eq(companies.id, companyId));
    as(owner);
    await expectAll(403, "forbidden");

    expect(await storedRow(id)).toMatchObject({ status: "draft", version: 1, number: null });
    expect(await auditActions(id)).toEqual(["document.draft_created"]);
  });
});

describe("document API: credit notes", () => {
  /** An issued invoice (lines l1: 10 × 65.00, l2: 10 × 45.00) and its stored row. */
  async function issuedInvoice(owner: Actor, companyId: string) {
    as(owner);
    const { id } = (await api.create(companyId, input())).body.document;
    const issued = (await api.issue(companyId, id, { expectedVersion: 1 })).body.document;
    expect(issued.number).toBe("INV-2026-0001");
    const [l1, l2] = issued.draft.lines.map((l: { id: string }) => l.id);
    return { id, l1: l1 as string, l2: l2 as string, row: await storedRow(id) };
  }

  /** The issued invoice row, snapshot and hash are exactly as they were at issue. */
  async function expectInvoiceUnchanged(
    owner: Actor,
    companyId: string,
    inv: Awaited<ReturnType<typeof issuedInvoice>>,
  ) {
    const now = await storedRow(inv.id);
    expect(now).toEqual(inv.row);
    expect(await verifyDocumentIntegrity(db, owner, companyId, inv.id)).toBe(true);
  }

  async function creditNoteCount(companyId: string) {
    const rows = await db
      .select({ id: documents.id })
      .from(documents)
      .where(and(eq(documents.companyId, companyId), eq(documents.type, "credit_note")));
    return rows.length;
  }

  it("creates a credit-note draft for an issued invoice; the number comes only at issue", async () => {
    const { owner, companyId } = await newCompany();
    const inv = await issuedInvoice(owner, companyId);

    const created = await api.creditNote(companyId, inv.id, {
      issueDate: "2026-03-10",
      language: "lv",
      lines: [{ sourceLineId: inv.l2, quantity: "6" }],
    });
    expect(created.status).toBe(201);
    const cn = created.body.document;
    expect(cn).toMatchObject({
      status: "draft",
      number: null,
      version: 1,
      draft: {
        type: "credit_note",
        language: "lv",
        issueDate: "2026-03-10",
        relation: { kind: "credits", documentId: inv.id, documentNumber: "INV-2026-0001" },
        lines: [{ quantity: "-6", sourceLineId: inv.l2 }],
      },
    });
    expect((await storedRow(cn.id))!.number).toBeNull();

    const issued = await api.issue(companyId, cn.id, { expectedVersion: 1 });
    expect(issued.status).toBe(200);
    expect(issued.body.document).toMatchObject({ status: "issued", number: "CN-2026-0001" });
    expect(issued.body.document.totals.grossTotal).toBe("-324.00");
    expect(await auditActions(cn.id)).toEqual([
      "document.credit_note_draft_created",
      "document.issued",
    ]);

    // "full" credits what remains; afterwards nothing is left to credit.
    const rest = (
      await api.creditNote(companyId, inv.id, { issueDate: "2026-03-11", lines: "full" })
    ).body.document;
    expect(rest.draft.lines).toEqual([
      expect.objectContaining({ sourceLineId: inv.l1, quantity: "-10" }),
      expect.objectContaining({ sourceLineId: inv.l2, quantity: "-4" }),
    ]);
    expect((await api.issue(companyId, rest.id, { expectedVersion: 1 })).body.document.number).toBe(
      "CN-2026-0002",
    );
    expect(
      await api.creditNote(companyId, inv.id, { issueDate: "2026-03-12", lines: "full" }),
    ).toMatchObject({
      status: 422,
      body: {
        error: "validation_failed",
        issues: [expect.objectContaining({ code: "creditNote.nothingRemaining" })],
      },
    });
    await expectInvoiceUnchanged(owner, companyId, inv);
  });

  it("refuses crediting more than remains, at creation and at issue, without using a number", async () => {
    const { owner, companyId } = await newCompany();
    const inv = await issuedInvoice(owner, companyId);
    const six = { issueDate: "2026-03-10", lines: [{ sourceLineId: inv.l2, quantity: "6" }] };

    // Each draft fits on its own; together they exceed the line.
    const a = (await api.creditNote(companyId, inv.id, six)).body.document;
    const b = (await api.creditNote(companyId, inv.id, six)).body.document;
    expect((await api.issue(companyId, a.id, { expectedVersion: 1 })).body.document.number).toBe(
      "CN-2026-0001",
    );
    expect(await api.issue(companyId, b.id, { expectedVersion: 1 })).toMatchObject({
      status: 422,
      body: {
        error: "validation_failed",
        issues: [expect.objectContaining({ code: "creditNote.quantity.exceedsRemaining" })],
      },
    });
    expect(await storedRow(b.id)).toMatchObject({ status: "draft", number: null });

    // A new draft beyond what remains is refused immediately and nothing is stored.
    const before = await creditNoteCount(companyId);
    expect(
      await api.creditNote(companyId, inv.id, {
        issueDate: "2026-03-10",
        lines: [{ sourceLineId: inv.l2, quantity: "5" }],
      }),
    ).toMatchObject({
      status: 422,
      body: { issues: [expect.objectContaining({ code: "creditNote.quantity.exceedsRemaining" })] },
    });
    expect(await creditNoteCount(companyId)).toBe(before);

    // What remains can still be credited, with the next number: the refused issue used none.
    const ok = (
      await api.creditNote(companyId, inv.id, {
        issueDate: "2026-03-10",
        lines: [{ sourceLineId: inv.l2, quantity: "4" }],
      })
    ).body.document;
    expect((await api.issue(companyId, ok.id, { expectedVersion: 1 })).body.document.number).toBe(
      "CN-2026-0002",
    );
    await expectInvoiceUnchanged(owner, companyId, inv);
  });

  it("only issued invoices can be credited", async () => {
    const { owner, companyId } = await newCompany();
    as(owner);
    const draft = (await api.create(companyId, input())).body.document;
    expect(
      await api.creditNote(companyId, draft.id, { issueDate: "2026-03-10", lines: "full" }),
    ).toMatchObject({ status: 409, body: { error: "invalid_state", code: "source.notIssued" } });

    const proforma = (await api.create(companyId, input({ type: "proforma" }))).body.document;
    expect((await api.issue(companyId, proforma.id, { expectedVersion: 1 })).status).toBe(200);
    expect(
      await api.creditNote(companyId, proforma.id, { issueDate: "2026-03-10", lines: "full" }),
    ).toMatchObject({ status: 409, body: { error: "invalid_state", code: "source.invalid" } });

    const inv = await issuedInvoice(owner, companyId);
    // The credit note cannot predate the invoice.
    expect(
      await api.creditNote(companyId, inv.id, { issueDate: "2026-03-01", lines: "full" }),
    ).toMatchObject({
      status: 422,
      body: { issues: [expect.objectContaining({ code: "creditNote.dateBeforeOriginal" })] },
    });
    const cn = (await api.creditNote(companyId, inv.id, { issueDate: "2026-03-10", lines: "full" }))
      .body.document;
    await api.issue(companyId, cn.id, { expectedVersion: 1 });
    // A credit note cannot itself be credited.
    const cnLine = (await api.get(companyId, cn.id)).body.document.draft.lines[0].id;
    expect(
      await api.creditNote(companyId, cn.id, {
        issueDate: "2026-03-10",
        lines: [{ sourceLineId: cnLine, quantity: "1" }],
      }),
    ).toMatchObject({ status: 409, body: { code: "source.invalid" } });
  });

  it("invalid bodies are 422, malformed requests 400, unknown or foreign invoices 404", async () => {
    const { owner, companyId } = await newCompany();
    const inv = await issuedInvoice(owner, companyId);
    const before = await creditNoteCount(companyId);
    const line = (quantity: string, extra: object = {}) => ({
      issueDate: "2026-03-10",
      lines: [{ sourceLineId: inv.l1, quantity, ...extra }],
    });

    const cases: [unknown, string][] = [
      [{ lines: "full" }, "issueDate"],
      [{ issueDate: "10.03.2026", lines: "full" }, "issueDate"],
      [{ issueDate: "2026-03-10", lines: "some" }, "lines"],
      [{ issueDate: "2026-03-10", lines: [] }, "lines"],
      [{ issueDate: "2026-03-10", language: "de", lines: "full" }, "language"],
      [line("-1"), "lines.0.quantity"],
      [line("abc"), "lines.0.quantity"],
      [line("1", { unitPrice: "1.00" }), "lines.0"], // unknown fields are refused, not ignored
    ];
    for (const [body, path] of cases) {
      const r = await api.creditNote(companyId, inv.id, body);
      expect(r.status, JSON.stringify(body)).toBe(422);
      expect(r.body.issues).toContainEqual(expect.objectContaining({ path }));
    }
    for (const [body, code] of [
      [line("0"), "creditNote.quantity.invalid"],
      [line("11"), "creditNote.quantity.exceedsRemaining"],
      [
        { issueDate: "2026-03-10", lines: [{ sourceLineId: "nope", quantity: "1" }] },
        "creditNote.sourceLine.unknown",
      ],
    ] as const) {
      expect(await api.creditNote(companyId, inv.id, body)).toMatchObject({
        status: 422,
        body: { issues: [expect.objectContaining({ code })] },
      });
    }
    expect((await api.creditNote(companyId, inv.id, "not json")).status).toBe(400);
    expect((await api.creditNote(companyId, "nope", { lines: "full" })).status).toBe(400);
    expect(
      await api.creditNote(companyId, randomUUID(), { issueDate: "2026-03-10", lines: "full" }),
    ).toMatchObject({ status: 404, body: { error: "not_found" } });

    // Another company's issued invoice is not found through this company's URL.
    const other = await newCompany();
    const foreign = await issuedInvoice(other.owner, other.companyId);
    as(owner);
    expect(
      await api.creditNote(companyId, foreign.id, { issueDate: "2026-03-10", lines: "full" }),
    ).toMatchObject({ status: 404, body: { error: "not_found" } });
    expect(await creditNoteCount(companyId)).toBe(before);
    expect(await creditNoteCount(other.companyId)).toBe(0);
    await expectInvoiceUnchanged(other.owner, other.companyId, foreign);
  });

  it("access: create needs documents.create, issue needs documents.approve; outsiders are refused", async () => {
    const { owner, companyId } = await newCompany();
    const inv = await issuedInvoice(owner, companyId);
    const body = { issueDate: "2026-03-10", lines: [{ sourceLineId: inv.l1, quantity: "1" }] };

    // Manager: may create the draft but not issue it.
    as(await member(companyId, "manager"));
    const cn = await api.creditNote(companyId, inv.id, body);
    expect(cn.status).toBe(201);
    expect(await api.issue(companyId, cn.body.document.id, { expectedVersion: 1 })).toMatchObject({
      status: 403,
      body: { error: "forbidden" },
    });
    expect((await storedRow(cn.body.document.id))!.number).toBeNull();

    // Accountant: may issue it.
    as(await member(companyId, "accountant"));
    expect(
      (await api.issue(companyId, cn.body.document.id, { expectedVersion: 1 })).body.document
        .number,
    ).toBe("CN-2026-0001");

    const count = await creditNoteCount(companyId);
    const refused: [Actor | null, number, string][] = [
      [await member(companyId, "warehouse_employee"), 403, "forbidden"],
      [await member(companyId, "production_employee"), 403, "forbidden"],
      [actorOf((await newUser()).id), 403, "forbidden"],
      [{ userId: owner.userId, twoFactorVerified: false }, 403, "two_factor_enrollment_required"],
      [null, 401, "unauthenticated"],
    ];
    for (const [actor, status, error] of refused) {
      as(actor);
      expect(await api.creditNote(companyId, inv.id, body)).toMatchObject({
        status,
        body: { error },
      });
    }
    await expectInvoiceUnchanged(owner, companyId, inv);
    await db.update(companies).set({ archivedAt: new Date() }).where(eq(companies.id, companyId));
    as(owner);
    expect(await api.creditNote(companyId, inv.id, body)).toMatchObject({
      status: 403,
      body: { error: "forbidden" },
    });
    expect(await creditNoteCount(companyId)).toBe(count);
    expect(await storedRow(inv.id)).toEqual(inv.row);
  });
});
