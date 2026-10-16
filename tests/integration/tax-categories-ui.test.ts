import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { type Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ApiDocument,
  chooseCategory,
  interpretResponse,
  legacySnapshots,
  restoreLegacy,
  toDraftInput,
} from "@/features/documents/editor-model";
import { createDraft } from "@/modules/documents/server/document-service";
import { ensureDefaultNumberSeries } from "@/modules/documents/server/numbering-service";
import {
  createTaxCategory,
  updateTaxCategory,
} from "@/modules/documents/server/tax-category-service";
import { type Actor } from "@/server/auth/authorization";
import { type AuthenticatedUser } from "@/server/auth/session";
import { type Database } from "@/server/db/client";
import { companies, documentLines, documents, memberships, roles, users } from "@/server/db/schema";
import { documentPageData, documentsListData } from "@/server/documents/page-data";
import { UnauthenticatedError } from "@/server/errors";
import { taxCategoriesPageData } from "@/server/tax-categories/page-data";
import { createCompanyWithOwner } from "@/server/tenancy/company-service";
import { FIXTURE_SELLER_PROFILE, FIXTURE_TAX, invoiceDraft } from "../support/document-fixtures";
import { openTestDb } from "./test-db";

/**
 * Stage C2: the catalog page loader, the editor's category data, and — above all — that saving a
 * draft never silently loses tax data entered before the catalog existed. Uses the real routes,
 * services and database; only the session lookup is stubbed. Fixture categories are arbitrary,
 * not real country rates. Synthetic data only.
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
const catalogRoute = await import("@/app/api/companies/[companyId]/tax-categories/route");

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
  email: "c2@example.test",
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
    .values({ email: `c2-${randomUUID()}@example.test` })
    .returning();
  return u!;
}

async function newCompany() {
  const owner = actorOf((await newUser()).id);
  const { companyId } = await createCompanyWithOwner(db, owner, { name: "C2 Co", country: "LV" });
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

const addCategory = async (actor: Actor, companyId: string, cat: object = FIXTURE_TAX.standard20) =>
  (await createTaxCategory(db, actor, companyId, cat)).taxCategory;

function input(categoryId: string | null) {
  const { lines, relation: _r, ...rest } = invoiceDraft();
  return {
    ...rest,
    lines: lines.map(({ id: _id, sourceLineId: _s, taxCategory: _t, ...l }) => ({
      ...l,
      taxCategoryId: categoryId,
    })),
  };
}

const req = (method: string, body: unknown) =>
  new Request("http://localhost/api", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const p = <T extends object>(v: T) => ({ params: Promise.resolve(v) });

/** The editor's save: PATCH with `toDraftInput`, classified like the UI does. */
async function save(
  companyId: string,
  documentId: string,
  doc: Pick<ApiDocument, "version" | "draft">,
) {
  const r = await single.PATCH(
    req("PATCH", { expectedVersion: doc.version, draft: toDraftInput(doc.draft) }),
    p({ companyId, documentId }),
  );
  return interpretResponse(r.status, await r.json());
}
async function issue(companyId: string, documentId: string, expectedVersion: number) {
  const r = await issueRoute.POST(req("POST", { expectedVersion }), p({ companyId, documentId }));
  return interpretResponse(r.status, await r.json());
}

/** A draft whose lines carry a pre-catalog snapshot (no catalog link), as before stage C1. */
async function legacyDraft(owner: Actor, companyId: string, categoryId: string) {
  const draft = await createDraft(db, owner, companyId, input(categoryId));
  await db
    .update(documentLines)
    .set({ taxCategoryId: null, taxCategory: FIXTURE_TAX.standard20 })
    .where(eq(documentLines.documentId, draft.id));
  return draft.id;
}

async function editorDoc(actor: Actor, companyId: string, documentId: string) {
  const data = await documentPageData(pageUser(actor), companyId, documentId);
  if (data.status !== "ok") throw new Error(`unexpected ${data.status}`);
  return data;
}

describe("old (pre-catalog) lines are never lost on save", () => {
  it("unchanged legacy lines keep their snapshot; issuing stays blocked; nothing is numbered", async () => {
    const { owner, companyId } = await newCompany();
    const cat = await addCategory(owner, companyId);
    const id = await legacyDraft(owner, companyId, cat.id);
    as(owner);

    const { document } = await editorDoc(owner, companyId, id);
    expect(document.issues.map((i) => i.code)).toContain("line.taxCategory.unlinked");
    // An unrelated edit, saved exactly as the editor sends it.
    const saved = await save(companyId, id, {
      ...document,
      draft: { ...document.draft, notes: "Edited without touching tax" },
    });
    expect(saved.kind).toBe("ok");
    if (saved.kind !== "ok") return;
    expect(saved.document.draft.lines.map((l) => l.taxCategory)).toEqual(
      document.draft.lines.map(() => FIXTURE_TAX.standard20),
    );
    expect(saved.document.draft.lines.every((l) => l.taxCategoryId === undefined)).toBe(true);
    expect(saved.document.issues.map((i) => i.code)).toContain("line.taxCategory.unlinked");
    // A second save (new line ids after the first) still keeps them.
    const again = await save(companyId, id, saved.document);
    expect(again.kind === "ok" && again.document.draft.lines[0]!.taxCategory).toEqual(
      FIXTURE_TAX.standard20,
    );

    expect((await issue(companyId, id, 3)).kind).toBe("invalid");
    const [row] = await db.select().from(documents).where(eq(documents.id, id));
    expect(row).toMatchObject({ status: "draft", number: null });
  });

  it("an explicit choice replaces the snapshot; restore before saving keeps the old one", async () => {
    const { owner, companyId } = await newCompany();
    const cat = await addCategory(owner, companyId);
    await updateTaxCategory(db, owner, companyId, cat.id, { expectedVersion: 1, label: "Renamed" });
    const id = await legacyDraft(owner, companyId, cat.id);
    as(owner);
    const { document, taxCategories } = await editorDoc(owner, companyId, id);
    const option = taxCategories.find((c) => c.id === cat.id)!;
    const previous = legacySnapshots(document.draft.lines);

    // Choose, then "Restore previous value" before saving: the old data survives the save.
    const restored = document.draft.lines.map((l) =>
      restoreLegacy(chooseCategory(l, option), previous.get(l.id)!),
    );
    const kept = await save(companyId, id, {
      ...document,
      draft: { ...document.draft, lines: restored },
    });
    expect(kept.kind === "ok" && kept.document.draft.lines[0]!.taxCategory).toEqual(
      FIXTURE_TAX.standard20,
    );
    if (kept.kind !== "ok") return;

    // Explicit choice: the catalog snapshot replaces the old one; issuing works.
    const chosen = kept.document.draft.lines.map((l) => chooseCategory(l, option));
    const replaced = await save(companyId, id, {
      ...kept.document,
      draft: { ...kept.document.draft, lines: chosen },
    });
    expect(replaced.kind).toBe("ok");
    if (replaced.kind !== "ok") return;
    expect(replaced.document.draft.lines[0]).toMatchObject({
      taxCategoryId: cat.id,
      taxCategory: { code: "T20", label: "Renamed" },
    });
    expect(replaced.document.issues).toEqual([]);
    // No hidden rollback: a later save keeps the chosen category.
    const later = await save(companyId, id, replaced.document);
    expect(later.kind === "ok" && later.document.draft.lines[0]!.taxCategoryId).toBe(cat.id);
    const issued = await issue(companyId, id, 4);
    expect(issued.kind === "ok" && issued.document.number).toBe("INV-2026-0001");
  });

  it("snapshots are only taken from the same draft: other drafts' and companies' line ids are ignored", async () => {
    const a = await newCompany();
    const b = await newCompany();
    const catA = await addCategory(a.owner, a.companyId);
    const catB = await addCategory(b.owner, b.companyId);
    const legacyA = await legacyDraft(a.owner, a.companyId, catA.id);
    const legacyB = await legacyDraft(b.owner, b.companyId, catB.id);
    const target = await createDraft(db, a.owner, a.companyId, input(null));

    const borrowFrom = async (actor: Actor, companyId: string, sourceId: string) => {
      const [sourceLine] = await db
        .select()
        .from(documentLines)
        .where(eq(documentLines.documentId, sourceId))
        .orderBy(asc(documentLines.position));
      return sourceLine!.id;
    };
    as(a.owner);
    const { document } = await editorDoc(a.owner, a.companyId, target.id);
    for (const foreignLineId of [
      await borrowFrom(a.owner, a.companyId, legacyA),
      await borrowFrom(b.owner, b.companyId, legacyB),
    ]) {
      const lines = document.draft.lines.map((l, i) => (i === 0 ? { ...l, id: foreignLineId } : l));
      const saved = await save(a.companyId, target.id, {
        ...document,
        draft: { ...document.draft, lines },
      });
      expect(saved.kind).toBe("ok");
      if (saved.kind !== "ok") return;
      expect(saved.document.draft.lines.every((l) => l.taxCategory === null)).toBe(true);
      document.version = saved.document.version;
    }
  });
});

describe("page data for the catalog and the editor", () => {
  it("catalog page: manage flag per role; read-only roles see it; no access looks like 404", async () => {
    const { owner, companyId } = await newCompany();
    const cat = await addCategory(owner, companyId);
    await addCategory(owner, companyId, FIXTURE_TAX.exempt);
    await updateTaxCategory(db, owner, companyId, cat.id, { expectedVersion: 1, archived: true });
    const flag = async (a: Actor) => {
      const d = await taxCategoriesPageData(pageUser(a), companyId);
      return d.status === "ok" ? d.canManage : d.status;
    };
    const ownerData = await taxCategoriesPageData(pageUser(owner), companyId);
    expect(ownerData).toMatchObject({ status: "ok", canManage: true });
    if (ownerData.status === "ok")
      expect(ownerData.categories.map((c) => [c.code, c.archived])).toEqual([
        ["EX", false],
        ["T20", true],
      ]);
    expect(await flag(await member(companyId, "administrator"))).toBe(true);
    expect(await flag(await member(companyId, "accountant"))).toBe(true);
    expect(await flag(await member(companyId, "manager"))).toBe(false);
    expect(await flag(await member(companyId, "warehouse_employee"))).toBe(false);
    expect(await flag(await member(companyId, "production_employee"))).toBe("not_found");
    expect(await flag(actorOf((await newUser()).id))).toBe("not_found");
    expect(await taxCategoriesPageData(pageUser(owner), "not-a-uuid")).toEqual({
      status: "not_found",
    });
    expect(await flag({ userId: owner.userId, twoFactorVerified: false })).toBe(
      "two_factor_required",
    );

    // Read-only roles are refused by the API itself, whatever the UI shows.
    as(await member(companyId, "manager"));
    const refused = await catalogRoute.POST(req("POST", FIXTURE_TAX.reverse), p({ companyId }));
    expect(refused.status).toBe(403);

    await db.update(companies).set({ archivedAt: new Date() }).where(eq(companies.id, companyId));
    expect(await flag(owner)).toBe("not_found");
  });

  it("editor and list data: only active categories are offered; empty-catalog hint data", async () => {
    const { owner, companyId } = await newCompany();
    const list = async (a: Actor) => {
      const d = await documentsListData(pageUser(a), companyId);
      if (d.status !== "ok") throw new Error(d.status);
      return d;
    };
    expect(await list(owner)).toMatchObject({
      hasTaxCategories: false,
      permissions: { canManageTaxCategories: true },
    });
    const manager = await member(companyId, "manager");
    expect((await list(manager)).permissions.canManageTaxCategories).toBe(false);

    const active = await addCategory(owner, companyId);
    const old = await addCategory(owner, companyId, FIXTURE_TAX.zero);
    await updateTaxCategory(db, owner, companyId, old.id, { expectedVersion: 1, archived: true });
    expect((await list(owner)).hasTaxCategories).toBe(true);

    const draft = await createDraft(db, owner, companyId, input(active.id));
    const data = await editorDoc(manager, companyId, draft.id);
    expect(data.taxCategories.map((c) => c.id)).toEqual([active.id]);
    expect(data.permissions).toMatchObject({
      canEdit: true,
      canIssue: false,
      canManageTaxCategories: false,
    });
  });
});

function as(actor: Actor | null) {
  session.actor = actor;
}
