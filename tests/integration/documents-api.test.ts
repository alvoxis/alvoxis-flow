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
  const { lines, relation: _r, ...rest } = invoiceDraft(overrides);
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
