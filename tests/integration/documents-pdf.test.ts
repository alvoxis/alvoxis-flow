import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { type Pool } from "pg";
import { extractText } from "unpdf";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type IssuedDocument } from "@/modules/documents/domain";
import { renderDocumentPdf } from "@/modules/documents/pdf/render";
import { createDraft, issueDocument } from "@/modules/documents/server/document-service";
import { ensureDefaultNumberSeries } from "@/modules/documents/server/numbering-service";
import { updateTaxCategory } from "@/modules/documents/server/tax-category-service";
import { type Actor } from "@/server/auth/authorization";
import { type Database } from "@/server/db/client";
import { companies, documents, memberships, roles, users } from "@/server/db/schema";
import { UnauthenticatedError } from "@/server/errors";
import { createCompanyWithOwner } from "@/server/tenancy/company-service";
import { FIXTURE_SELLER_PROFILE, FIXTURE_TAX, invoiceDraft } from "../support/document-fixtures";
import {
  addFixtureTaxCategories,
  type FixtureCategoryIds,
  withCategoryIds,
} from "../support/tax-category-fixtures";
import { openTestDb } from "./test-db";

/**
 * PDF of real documents through `GET …/documents/{id}/pdf` (real route, services, renderer and
 * database; only the session lookup is stubbed). Synthetic data only.
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

const pdfRoute = await import("@/app/api/companies/[companyId]/documents/[documentId]/pdf/route");

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

async function newUser() {
  const [u] = await db
    .insert(users)
    .values({ email: `pdf-${randomUUID()}@example.test` })
    .returning();
  return u!;
}

async function newCompany() {
  const owner = actorOf((await newUser()).id);
  const { companyId } = await createCompanyWithOwner(db, owner, { name: "Pdf Co", country: "LV" });
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

function input(cats: FixtureCategoryIds) {
  const { lines, relation: _r, ...rest } = invoiceDraft();
  return {
    ...rest,
    lines: withCategoryIds(
      lines.map(({ id: _i, sourceLineId: _s, ...l }) => l),
      cats,
    ),
  };
}

async function getPdf(actor: Actor | null, companyId: string, documentId: string, query = "") {
  session.actor = actor;
  const res = await pdfRoute.GET(new Request(`http://localhost/api/pdf${query}`), {
    params: Promise.resolve({ companyId, documentId }),
  });
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { res, bytes };
}

const textOf = async (bytes: Uint8Array) =>
  (await extractText(bytes.slice(), { mergePages: true })).text.replace(/[\s  ]+/g, " ");

describe("document PDF", { timeout: 60_000 }, () => {
  it("issued: rendered only from the frozen snapshot, even after profile and catalog changes", async () => {
    const { owner, companyId, cats } = await newCompany();
    const draft = await createDraft(db, owner, companyId, input(cats));
    const issued = await issueDocument(db, owner, companyId, draft.id, 1);
    // Later changes to the company profile and the catalog must not reach the issued PDF.
    await db
      .update(companies)
      .set({ legalName: "Pārdēvēta SIA", addressLine1: "Jauna iela 99" })
      .where(eq(companies.id, companyId));
    await updateTaxCategory(db, owner, companyId, cats[FIXTURE_TAX.standard20.code]!, {
      expectedVersion: 1,
      label: "Relabelled later",
    });

    const { res, bytes } = await getPdf(owner, companyId, issued.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe('inline; filename="INV-2026-0001.pdf"');
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(Buffer.from(bytes.subarray(0, 5)).toString()).toBe("%PDF-");

    const text = await textOf(bytes);
    expect(text).toContain("INV-2026-0001");
    expect(text).toContain(FIXTURE_SELLER_PROFILE.legalName);
    expect(text).toContain("Tax 20%"); // the tax summary of the snapshot
    expect(text).toContain(issued.contentHash!.slice(0, 16));
    expect(text).not.toContain("Pārdēvēta SIA");
    expect(text).not.toContain("Jauna iela 99");
    expect(text).not.toContain("Relabelled later");
    expect(text).not.toContain("DRAFT");

    // Same text as rendering the stored snapshot directly.
    const [row] = await db.select().from(documents).where(eq(documents.id, issued.id));
    const snapshot = row!.snapshot as unknown as IssuedDocument;
    const direct = await renderDocumentPdf({
      document: snapshot,
      status: "issued",
      number: snapshot.number,
      totals: snapshot.totals,
      contentHash: snapshot.contentHash,
    });
    expect(text).toBe(await textOf(new Uint8Array(direct)));

    const download = await getPdf(owner, companyId, issued.id, "?download=1");
    expect(download.res.headers.get("content-disposition")).toBe(
      'attachment; filename="INV-2026-0001.pdf"',
    );
  });

  it("draft: watermarked preview without a number", async () => {
    const { owner, companyId, cats } = await newCompany();
    const draft = await createDraft(db, owner, companyId, input(cats));
    const { res, bytes } = await getPdf(owner, companyId, draft.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe(
      `inline; filename="draft-invoice-${draft.id.slice(0, 8)}.pdf"`,
    );
    const text = await textOf(bytes);
    expect(text).toContain("DRAFT — not issued");
    expect(text).not.toContain("INV-2026-");
    expect(text).toContain("Example Workwear SIA");
  });

  it("access: documents.view roles only; foreign and unknown documents reveal nothing", async () => {
    const a = await newCompany();
    const b = await newCompany();
    const draftA = await createDraft(db, a.owner, a.companyId, input(a.cats));
    const draftB = await createDraft(db, b.owner, b.companyId, input(b.cats));

    expect(
      (await getPdf(await member(a.companyId, "warehouse_employee"), a.companyId, draftA.id)).res
        .status,
    ).toBe(200);
    expect(
      (await getPdf(await member(a.companyId, "accountant"), a.companyId, draftA.id)).res.status,
    ).toBe(200);

    const refused = async (actor: Actor | null, companyId: string, id: string) => {
      const { res, bytes } = await getPdf(actor, companyId, id);
      expect(res.headers.get("content-type")).toContain("application/json");
      return { status: res.status, body: JSON.parse(Buffer.from(bytes).toString()) };
    };
    expect(await refused(null, a.companyId, draftA.id)).toEqual({
      status: 401,
      body: { error: "unauthenticated" },
    });
    // No documents.view, non-member, unknown company: the same 403.
    const production = await member(a.companyId, "production_employee");
    expect((await refused(production, a.companyId, draftA.id)).status).toBe(403);
    expect((await refused(b.owner, a.companyId, draftA.id)).status).toBe(403);
    expect((await refused(a.owner, randomUUID(), draftA.id)).status).toBe(403);
    // Another company's document through this company's URL, or an unknown id: the same 404.
    expect(await refused(a.owner, a.companyId, draftB.id)).toEqual({
      status: 404,
      body: { error: "not_found" },
    });
    expect((await refused(a.owner, a.companyId, randomUUID())).status).toBe(404);
    expect((await refused(a.owner, a.companyId, "not-a-uuid")).status).toBe(400);
    expect(
      (await refused({ userId: a.owner.userId, twoFactorVerified: false }, a.companyId, draftA.id))
        .body,
    ).toEqual({
      error: "two_factor_enrollment_required",
    });
    await db.update(companies).set({ archivedAt: new Date() }).where(eq(companies.id, a.companyId));
    expect((await refused(a.owner, a.companyId, draftA.id)).status).toBe(403);
  });
});
