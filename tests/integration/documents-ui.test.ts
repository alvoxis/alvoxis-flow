import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { type Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { interpretResponse, toDraftInput } from "@/features/documents/editor-model";
import { createDraft } from "@/modules/documents/server/document-service";
import { ensureDefaultNumberSeries } from "@/modules/documents/server/numbering-service";
import { type Actor } from "@/server/auth/authorization";
import { type AuthenticatedUser } from "@/server/auth/session";
import { type Database } from "@/server/db/client";
import { companies, memberships, roles, users } from "@/server/db/schema";
import { documentPageData, documentsListData } from "@/server/documents/page-data";
import { createCompanyWithOwner } from "@/server/tenancy/company-service";
import { UnauthenticatedError } from "@/server/errors";
import { FIXTURE_SELLER_PROFILE, invoiceDraft } from "../support/document-fixtures";
import {
  addFixtureTaxCategories,
  withCategoryIds,
  type FixtureCategoryIds,
} from "../support/tax-category-fixtures";
import { openTestDb } from "./test-db";

/**
 * Documents UI: the page loaders (access and permission flags) and the editor's request bodies
 * against the real route handlers and database. Only the session lookup is stubbed, as in
 * documents-api.test.ts. Synthetic data only.
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
const pageUser = (a: Actor): AuthenticatedUser => ({
  userId: a.userId,
  email: "ui@example.test",
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
    .values({ email: `docs-ui-${randomUUID()}@example.test` })
    .returning();
  return u!;
}

/** Catalog of the most recently created company (inputs reference it by id). */
let cats: FixtureCategoryIds = {};

async function newCompany() {
  const owner = actorOf((await newUser()).id);
  const { companyId } = await createCompanyWithOwner(db, owner, { name: "Ui Co", country: "LV" });
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

const req = (method: string, body: unknown) =>
  new Request("http://localhost/api", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const p = <T extends object>(v: T) => ({ params: Promise.resolve(v) });

/** What the editor does: PATCH/POST with its body, then classify the answer. */
async function editorCall(res: Promise<Response>) {
  const r = await res;
  return interpretResponse(r.status, await r.json());
}
const save = (companyId: string, documentId: string, expectedVersion: number, draft: unknown) =>
  editorCall(single.PATCH(req("PATCH", { expectedVersion, draft }), p({ companyId, documentId })));
const issue = (companyId: string, documentId: string, expectedVersion: number) =>
  editorCall(issueRoute.POST(req("POST", { expectedVersion }), p({ companyId, documentId })));

async function pageDoc(actor: Actor, companyId: string, documentId: string) {
  const data = await documentPageData(pageUser(actor), companyId, documentId);
  if (data.status !== "ok") throw new Error(`unexpected ${data.status}`);
  return data;
}

describe("documents UI", () => {
  it("saves an edited draft through the editor body, then issues it; issued is read-only", async () => {
    const { owner, companyId } = await newCompany();
    const created = await createDraft(db, owner, companyId, input({ buyer: { name: "Old SIA" } }));
    as(owner);

    const loaded = await pageDoc(owner, companyId, created.id);
    expect(loaded.permissions).toEqual({
      canEdit: true,
      canIssue: true,
      canManageTaxCategories: true,
    });
    const edited = {
      ...loaded.document.draft,
      buyer: { ...loaded.document.draft.buyer, name: "Jauns Pircējs SIA", vatNumber: "" },
      notes: "Saved from the editor",
    };
    const saved = await save(companyId, created.id, loaded.document.version, toDraftInput(edited));
    expect(saved.kind).toBe("ok");
    if (saved.kind !== "ok") return;
    expect(saved.document).toMatchObject({
      version: 2,
      draft: { buyer: { name: "Jauns Pircējs SIA" }, notes: "Saved from the editor" },
    });
    expect(saved.document.draft.buyer.vatNumber).toBeUndefined();
    // Totals are the server's numbers; the editor only displays them.
    expect(saved.document.totals?.grossTotal).toBe(loaded.document.totals?.grossTotal);

    // A second tab still holding version 1 gets a conflict, and nothing changes.
    expect(await save(companyId, created.id, 1, toDraftInput(edited))).toEqual({
      kind: "conflict",
    });

    const issued = await issue(companyId, created.id, 2);
    expect(issued).toMatchObject({
      kind: "ok",
      document: { status: "issued", number: "INV-2026-0001" },
    });

    // After issuing, the page shows the number and the editor's save is refused.
    const after = await pageDoc(owner, companyId, created.id);
    expect(after.document).toMatchObject({ status: "issued", number: "INV-2026-0001", issues: [] });
    expect(await save(companyId, created.id, 2, toDraftInput(edited))).toEqual({
      kind: "notDraft",
    });
    expect(await issue(companyId, created.id, 2)).toEqual({ kind: "notDraft" });
    const list = await documentsListData(pageUser(owner), companyId);
    expect(list).toMatchObject({
      status: "ok",
      documents: [{ id: created.id, status: "issued", number: "INV-2026-0001" }],
    });
  });

  it("validation errors come back as issues with paths; nothing is saved or numbered", async () => {
    const { owner, companyId } = await newCompany();
    const created = await createDraft(db, owner, companyId, input());
    as(owner);
    const { document } = await pageDoc(owner, companyId, created.id);
    const broken = {
      ...document.draft,
      buyer: { ...document.draft.buyer, name: "" },
      lines: document.draft.lines.map((l) => ({ ...l, unitPrice: "", quantity: "abc" })),
    };
    // Shape errors (quantity "abc") are rejected on save with input.* codes and field paths.
    const rejected = await save(companyId, created.id, 1, toDraftInput(broken));
    expect(rejected.kind).toBe("invalid");
    if (rejected.kind === "invalid")
      expect(rejected.issues).toContainEqual(
        expect.objectContaining({ path: "lines.0.quantity", severity: "error" }),
      );

    // Business-rule errors are saved as findings on the draft and block issuing (422).
    const fixable = { ...broken, lines: broken.lines.map((l) => ({ ...l, quantity: "1" })) };
    const saved = await save(companyId, created.id, 1, toDraftInput(fixable));
    expect(saved.kind).toBe("ok");
    if (saved.kind !== "ok") return;
    expect(saved.document.totals).toBeNull();
    expect(saved.document.issues.map((i) => i.code)).toEqual(
      expect.arrayContaining(["buyer.name.required", "line.unitPrice.required"]),
    );
    const blocked = await issue(companyId, created.id, 2);
    expect(blocked.kind).toBe("invalid");
    expect((await pageDoc(owner, companyId, created.id)).document).toMatchObject({
      status: "draft",
      number: null,
      version: 2,
    });
  });

  it("permission flags follow the role; the server still enforces them", async () => {
    const { owner, companyId } = await newCompany();
    const { id } = await createDraft(db, owner, companyId, input());
    const flags = async (a: Actor) => (await pageDoc(a, companyId, id)).permissions;

    expect(await flags(await member(companyId, "accountant"))).toEqual({
      canEdit: true,
      canIssue: true,
      canManageTaxCategories: true,
    });
    const manager = await member(companyId, "manager");
    expect(await flags(manager)).toEqual({
      canEdit: true,
      canIssue: false,
      canManageTaxCategories: false,
    });
    const warehouse = await member(companyId, "warehouse_employee");
    expect(await flags(warehouse)).toEqual({
      canEdit: false,
      canIssue: false,
      canManageTaxCategories: false,
    });

    as(manager);
    expect(await issue(companyId, id, 1)).toEqual({ kind: "forbidden" });
    as(warehouse);
    expect(await save(companyId, id, 1, input())).toEqual({ kind: "forbidden" });

    // No documents.view → the pages behave as if the company did not exist.
    const production = await member(companyId, "production_employee");
    expect(await documentsListData(pageUser(production), companyId)).toEqual({
      status: "not_found",
    });
    expect(await documentPageData(pageUser(production), companyId, id)).toEqual({
      status: "not_found",
    });
  });

  it("non-members, unknown ids, 2FA and archived companies", async () => {
    const { owner, companyId } = await newCompany();
    const { id } = await createDraft(db, owner, companyId, input());
    const stranger = pageUser(actorOf((await newUser()).id));
    expect(await documentsListData(stranger, companyId)).toEqual({ status: "not_found" });
    expect(await documentPageData(stranger, companyId, id)).toEqual({ status: "not_found" });
    expect(await documentPageData(pageUser(owner), companyId, randomUUID())).toEqual({
      status: "not_found",
    });
    expect(await documentPageData(pageUser(owner), "not-a-uuid", id)).toEqual({
      status: "not_found",
    });

    const noSecondFactor = pageUser({ userId: owner.userId, twoFactorVerified: false });
    expect(await documentsListData(noSecondFactor, companyId)).toEqual({
      status: "two_factor_required",
    });
    expect(await documentPageData(noSecondFactor, companyId, id)).toEqual({
      status: "two_factor_required",
    });
    as({ userId: owner.userId, twoFactorVerified: false });
    expect(await save(companyId, id, 1, input())).toEqual({ kind: "twoFactor" });

    await db.update(companies).set({ archivedAt: new Date() }).where(eq(companies.id, companyId));
    expect(await documentsListData(pageUser(owner), companyId)).toEqual({ status: "not_found" });
    as(owner);
    expect(await save(companyId, id, 1, input())).toEqual({ kind: "forbidden" });
    expect(await issue(companyId, id, 1)).toEqual({ kind: "forbidden" });
  });
});

function as(actor: Actor | null) {
  session.actor = actor;
}
