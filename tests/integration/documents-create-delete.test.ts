import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { type Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  interpretDeleteResponse,
  type NewDocumentForm,
  toCreateDraftBody,
} from "@/features/documents/create-model";
import { interpretResponse } from "@/features/documents/editor-model";
import {
  createDraft,
  issueDocument,
  verifyDocumentIntegrity,
} from "@/modules/documents/server/document-service";
import { ensureDefaultNumberSeries } from "@/modules/documents/server/numbering-service";
import { type Actor } from "@/server/auth/authorization";
import { type Database } from "@/server/db/client";
import { auditLogs, companies, documents, memberships, roles, users } from "@/server/db/schema";
import { UnauthenticatedError } from "@/server/errors";
import { createCompanyWithOwner } from "@/server/tenancy/company-service";
import { FIXTURE_SELLER_PROFILE, invoiceDraft } from "../support/document-fixtures";
import { addFixtureTaxCategories, withCategoryIds } from "../support/tax-category-fixtures";
import { openTestDb } from "./test-db";

/**
 * Stage B: creating drafts from the "New document" form and deleting drafts, through the real
 * route handlers, services and database (only the session lookup is stubbed). The request bodies
 * are exactly what the UI sends. Synthetic data only.
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
    .values({ email: `b-${randomUUID()}@example.test` })
    .returning();
  return u!;
}

async function newCompany() {
  const owner = actorOf((await newUser()).id);
  const { companyId } = await createCompanyWithOwner(db, owner, { name: "B Co", country: "LV" });
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

const form: NewDocumentForm = {
  type: "invoice",
  language: "en",
  currency: "EUR",
  issueDate: "2026-03-02",
  buyerName: "Testa Pircējs SIA",
};

const req = (method: string, body?: unknown) =>
  new Request("http://localhost/api", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const p = <T extends object>(v: T) => ({ params: Promise.resolve(v) });

async function create(companyId: string, body: unknown) {
  const r = await collection.POST(req("POST", body), p({ companyId }));
  return { status: r.status, outcome: interpretResponse(r.status, await r.clone().json()) };
}
async function remove(companyId: string, documentId: string) {
  const r = await single.DELETE(req("DELETE"), p({ companyId, documentId }));
  return interpretDeleteResponse(r.status, await r.json());
}
const documentCount = async (companyId: string) =>
  (await db.select().from(documents).where(eq(documents.companyId, companyId))).length;
const auditActions = async (entityId: string) =>
  (
    await db
      .select({ action: auditLogs.action })
      .from(auditLogs)
      .where(eq(auditLogs.entityId, entityId))
      .orderBy(asc(auditLogs.createdAt))
  ).map((r) => r.action);

/** An issued invoice of the company (lines with fixture catalog categories). */
async function issuedInvoice(owner: Actor, companyId: string) {
  const cats = await addFixtureTaxCategories(db, owner, companyId);
  const { lines, relation: _r, ...rest } = invoiceDraft();
  const draft = await createDraft(db, owner, companyId, {
    ...rest,
    lines: withCategoryIds(
      lines.map(({ id: _i, sourceLineId: _s, ...l }) => l),
      cats,
    ),
  });
  return issueDocument(db, owner, companyId, draft.id, 1);
}

describe("creating a draft from the New document form", () => {
  it("accepts the minimal body; the seller comes from the profile; delete removes it with audit", async () => {
    const { owner, companyId } = await newCompany();
    as(owner);
    const created = await create(companyId, toCreateDraftBody(form));
    expect(created.status).toBe(201);
    expect(created.outcome.kind).toBe("ok");
    if (created.outcome.kind !== "ok") return;
    const doc = created.outcome.document;
    expect(doc).toMatchObject({
      status: "draft",
      number: null,
      version: 1,
      draft: {
        type: "invoice",
        currency: "EUR",
        issueDate: "2026-03-02",
        buyer: { name: "Testa Pircējs SIA" },
        lines: [],
      },
    });
    expect(doc.draft.seller.name).toBe(FIXTURE_SELLER_PROFILE.legalName);
    // Lines (and their tax categories) are added later in the editor; issuing is blocked until then.
    expect(doc.issues.map((i) => i.code)).toContain("lines.required");

    expect(await remove(companyId, doc.id)).toEqual({ kind: "deleted" });
    expect(await remove(companyId, doc.id)).toEqual({ kind: "notFound" });
    expect(await auditActions(doc.id)).toEqual([
      "document.draft_created",
      "document.draft_deleted",
    ]);
  });

  it("refuses a missing currency and credit notes; nothing is created", async () => {
    const { owner, companyId } = await newCompany();
    as(owner);
    const noCurrency = await create(companyId, toCreateDraftBody({ ...form, currency: "" }));
    expect(noCurrency.status).toBe(422);
    expect(noCurrency.outcome.kind).toBe("invalid");
    const creditNote = await create(companyId, { ...toCreateDraftBody(form), type: "credit_note" });
    expect(creditNote).toMatchObject({ status: 409, outcome: { kind: "state" } });
    expect(await documentCount(companyId)).toBe(0);
  });
});

describe("permissions for creating and deleting drafts", () => {
  it("documents.create roles may create and delete; others are refused by the server", async () => {
    const { owner, companyId } = await newCompany();
    for (const role of ["accountant", "manager"]) {
      as(await member(companyId, role));
      const created = await create(companyId, toCreateDraftBody(form));
      expect(created.status).toBe(201);
      if (created.outcome.kind !== "ok") return;
      expect(await remove(companyId, created.outcome.document.id)).toEqual({ kind: "deleted" });
    }

    as(owner);
    const target = await create(companyId, toCreateDraftBody(form));
    if (target.outcome.kind !== "ok") throw new Error("setup");
    const id = target.outcome.document.id;
    for (const role of ["warehouse_employee", "production_employee"]) {
      as(await member(companyId, role));
      expect((await create(companyId, toCreateDraftBody(form))).status).toBe(403);
      expect(await remove(companyId, id)).toEqual({ kind: "forbidden" });
    }
    as(actorOf((await newUser()).id));
    expect((await create(companyId, toCreateDraftBody(form))).status).toBe(403);
    expect(await remove(companyId, id)).toEqual({ kind: "forbidden" });
    as({ userId: owner.userId, twoFactorVerified: false });
    expect(await remove(companyId, id)).toEqual({ kind: "twoFactor" });
    expect((await create(companyId, toCreateDraftBody(form))).outcome.kind).toBe("twoFactor");

    await db.update(companies).set({ archivedAt: new Date() }).where(eq(companies.id, companyId));
    as(owner);
    expect((await create(companyId, toCreateDraftBody(form))).status).toBe(403);
    expect(await remove(companyId, id)).toEqual({ kind: "forbidden" });
    expect(await documentCount(companyId)).toBe(1); // the target draft is still there
  });

  it("issued documents cannot be deleted; snapshot and hash stay unchanged", async () => {
    const { owner, companyId } = await newCompany();
    const issued = await issuedInvoice(owner, companyId);
    const [before] = await db.select().from(documents).where(eq(documents.id, issued.id));
    as(owner);
    expect(await remove(companyId, issued.id)).toEqual({ kind: "notDraft" });
    const [after] = await db.select().from(documents).where(eq(documents.id, issued.id));
    expect(after).toEqual(before);
    expect(after!.contentHash).toBe(issued.contentHash);
    expect(await verifyDocumentIntegrity(db, owner, companyId, issued.id)).toBe(true);
    expect(await auditActions(issued.id)).not.toContain("document.draft_deleted");
  });

  it("another company's draft is not found through this company and stays intact", async () => {
    const a = await newCompany();
    const b = await newCompany();
    as(b.owner);
    const foreign = await create(b.companyId, toCreateDraftBody(form));
    if (foreign.outcome.kind !== "ok") throw new Error("setup");
    as(a.owner);
    expect(await remove(a.companyId, foreign.outcome.document.id)).toEqual({ kind: "notFound" });
    expect(await remove(b.companyId, foreign.outcome.document.id)).toEqual({ kind: "forbidden" });
    expect(await documentCount(b.companyId)).toBe(1);
  });
});
