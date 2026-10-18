import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { type Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_UPLOAD_BYTES } from "@/features/documents/import-model";
import { renderDocumentPdf } from "@/modules/documents/pdf/render";
import { sampleModels } from "@/modules/documents/sample/sample-documents";
import { ensureDefaultNumberSeries } from "@/modules/documents/server/numbering-service";
import { type Actor } from "@/server/auth/authorization";
import { type Database } from "@/server/db/client";
import { auditLogs, companies, documents, memberships, roles, users } from "@/server/db/schema";
import { UnauthenticatedError } from "@/server/errors";
import { createCompanyWithOwner } from "@/server/tenancy/company-service";
import { FIXTURE_SELLER_PROFILE, FIXTURE_TAX } from "../support/document-fixtures";
import { addFixtureTaxCategories } from "../support/tax-category-fixtures";
import { openTestDb } from "./test-db";

/**
 * The PDF import HTTP API (preview → review → create draft) through the real routes, services and
 * database; only the session lookup is stubbed. The PDF is a FICTITIOUS sample rendered by the app.
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

const previewRoute = await import("@/app/api/companies/[companyId]/documents/import/preview/route");
const createRoute = await import("@/app/api/companies/[companyId]/documents/import/route");

let db: Database;
let pool: Pool;
let pdf: Uint8Array;
beforeAll(async () => {
  ({ db, pool } = openTestDb());
  session.db = db;
  pdf = new Uint8Array(await renderDocumentPdf(sampleModels("en").invoice!));
});
afterAll(async () => pool.end());
beforeEach(() => {
  session.actor = null;
});

const actorOf = (userId: string): Actor => ({ userId, twoFactorVerified: true });

async function newUser() {
  const [u] = await db
    .insert(users)
    .values({ email: `impapi-${randomUUID()}@example.test` })
    .returning();
  return u!;
}

async function newCompany() {
  const owner = actorOf((await newUser()).id);
  const { companyId } = await createCompanyWithOwner(db, owner, { name: "Imp Co", country: "LV" });
  await db.update(companies).set(FIXTURE_SELLER_PROFILE).where(eq(companies.id, companyId));
  await ensureDefaultNumberSeries(db, owner, companyId);
  const cats = await addFixtureTaxCategories(db, owner, companyId);
  return { owner, companyId, taxCategoryId: cats[FIXTURE_TAX.standard20.code]! };
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

function body(files: Uint8Array[], decisions?: unknown) {
  const form = new FormData();
  for (const f of files)
    form.append("file", new File([f.slice()], "rēķins.pdf", { type: "application/pdf" }));
  if (decisions !== undefined)
    form.set("decisions", typeof decisions === "string" ? decisions : JSON.stringify(decisions));
  return form;
}

async function call(
  route: { POST: (r: Request, p: { params: Promise<{ companyId: string }> }) => Promise<Response> },
  actor: Actor | null,
  companyId: string,
  form: FormData,
  headers: Record<string, string> = {},
) {
  session.actor = actor;
  const res = await route.POST(
    new Request("http://localhost/api", { method: "POST", body: form, headers }),
    {
      params: Promise.resolve({ companyId }),
    },
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

const documentCount = async (companyId: string) =>
  (await db.select({ id: documents.id }).from(documents).where(eq(documents.companyId, companyId)))
    .length;

/** Decisions as the review screen would send them after the user checked everything. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function decisionsFor(review: Record<string, any>, taxCategoryId: string, extra: object = {}) {
  return {
    type: "invoice",
    language: "en",
    currency: "EUR",
    issueDate: review.issueDate.value,
    dueDate: review.dueDate.value,
    seller: { name: "Ignored: the profile decides" },
    buyer: { name: review.buyer.name.value },
    defaultTaxCategoryId: taxCategoryId,
    lines: review.lines.map((l: Record<string, string>) => ({
      description: l.description,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
    })),
    acknowledgedFlags: [
      ...new Set(
        review.flags
          .filter((f: { severity: string }) => f.severity !== "info")
          .map((f: { code: string }) => f.code),
      ),
    ],
    ...extra,
  };
}

describe("PDF import API", { timeout: 60_000 }, () => {
  it("preview reads the file, creates nothing and audits only metadata", async () => {
    const c = await newCompany();
    const r = await call(previewRoute, c.owner, c.companyId, body([pdf]));
    expect(r.status).toBe(200);
    expect(r.body.review).toMatchObject({
      status: "needs_review",
      number: { value: "INV-2026-0001" },
      currency: { value: "EUR" },
      issueDate: { value: "2026-03-02" },
    });
    expect(r.body.review.lines).toHaveLength(4);
    expect(await documentCount(c.companyId)).toBe(0);
    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.companyId, c.companyId),
          eq(auditLogs.action, "document.import_previewed"),
        ),
      );
    expect(JSON.stringify(audit!.metadata)).not.toContain("Example Workwear");
  });

  it("creates a draft only after every finding was checked; the seller comes from the profile", async () => {
    const c = await newCompany();
    const { body: preview } = await call(previewRoute, c.owner, c.companyId, body([pdf]));
    const review = preview.review;

    // The English sample prints 02/03/2026, an ambiguous date: a finding the user must check.
    expect(review.flags).toContainEqual(
      expect.objectContaining({ code: "date.formatAmbiguous", severity: "warning" }),
    );
    const unchecked = await call(
      createRoute,
      c.owner,
      c.companyId,
      body([pdf], decisionsFor(review, c.taxCategoryId, { acknowledgedFlags: [] })),
    );
    expect(unchecked).toMatchObject({
      status: 422,
      body: { error: "validation_failed", issues: [{ code: "import.flags.unresolved" }] },
    });
    expect(await documentCount(c.companyId)).toBe(0);

    const created = await call(
      createRoute,
      c.owner,
      c.companyId,
      body([pdf], decisionsFor(review, c.taxCategoryId)),
    );
    expect(created.status).toBe(201);
    expect(created.body.document).toMatchObject({
      status: "draft",
      number: null,
      draft: {
        type: "invoice",
        currency: "EUR",
        seller: { name: FIXTURE_SELLER_PROFILE.legalName },
        buyer: { name: review.buyer.name.value },
      },
    });
    expect(created.body.document.draft.lines).toHaveLength(4);
    const [row] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, created.body.document.id));
    expect(row!.sourceFileSha256).toBe(review.fileSha256);

    // The same file again is a certain duplicate that must be confirmed.
    const again = (await call(previewRoute, c.owner, c.companyId, body([pdf]))).body.review;
    expect(again.duplicates[0]).toMatchObject({ documentId: row!.id, strength: "certain" });
    expect(
      await call(
        createRoute,
        c.owner,
        c.companyId,
        body([pdf], decisionsFor(again, c.taxCategoryId)),
      ),
    ).toMatchObject({
      status: 422,
      body: { issues: [{ code: "import.duplicates.unacknowledged" }] },
    });
    expect(
      (
        await call(
          createRoute,
          c.owner,
          c.companyId,
          body([pdf], decisionsFor(again, c.taxCategoryId, { acknowledgedDuplicates: true })),
        )
      ).status,
    ).toBe(201);
  });

  it("refuses bad uploads: size, type, number of files, decisions", async () => {
    const c = await newCompany();
    const big = new Uint8Array(MAX_UPLOAD_BYTES + 1);
    big.set(new TextEncoder().encode("%PDF-"));
    expect(await call(previewRoute, c.owner, c.companyId, body([big]))).toMatchObject({
      status: 413,
      body: { error: "file_too_large" },
    });
    // An oversized body is refused from its declared length, before it is read.
    expect(
      await call(previewRoute, c.owner, c.companyId, body([pdf]), {
        "content-length": String(50 * 1024 * 1024),
      }),
    ).toMatchObject({ status: 413 });
    expect(
      await call(previewRoute, c.owner, c.companyId, body([new TextEncoder().encode("hello")])),
    ).toMatchObject({ status: 409, body: { code: "import.file.notPdf" } });
    expect(await call(previewRoute, c.owner, c.companyId, body([]))).toMatchObject({ status: 400 });
    expect(await call(previewRoute, c.owner, c.companyId, body([pdf, pdf]))).toMatchObject({
      status: 400,
    });
    expect(await call(createRoute, c.owner, c.companyId, body([pdf]))).toMatchObject({
      status: 400,
    });
    expect(await call(createRoute, c.owner, c.companyId, body([pdf], "{not json"))).toMatchObject({
      status: 400,
    });
    const strict = await call(
      createRoute,
      c.owner,
      c.companyId,
      body([pdf], { type: "invoice", extra: 1 }),
    );
    expect(strict.status).toBe(422);
    expect(await documentCount(c.companyId)).toBe(0);
  });

  it("access: documents.create only, own company only, signed-in only", async () => {
    const c = await newCompany();
    const other = await newCompany();
    const manager = await member(c.companyId, "manager");
    const warehouse = await member(c.companyId, "warehouse_employee");
    expect((await call(previewRoute, manager, c.companyId, body([pdf]))).status).toBe(200);
    expect(await call(previewRoute, warehouse, c.companyId, body([pdf]))).toMatchObject({
      status: 403,
      body: { error: "forbidden" },
    });
    expect((await call(previewRoute, other.owner, c.companyId, body([pdf]))).status).toBe(403);
    expect(await call(previewRoute, null, c.companyId, body([pdf]))).toMatchObject({
      status: 401,
      body: { error: "unauthenticated" },
    });
    expect(
      await call(previewRoute, { ...c.owner, twoFactorVerified: false }, c.companyId, body([pdf])),
    ).toMatchObject({ status: 403, body: { error: "two_factor_enrollment_required" } });
    // A tax category of another company cannot be used for the imported lines.
    const review = (await call(previewRoute, c.owner, c.companyId, body([pdf]))).body.review;
    const foreign = await call(
      createRoute,
      c.owner,
      c.companyId,
      body([pdf], decisionsFor(review, other.taxCategoryId)),
    );
    expect(foreign.status).toBe(422);
    expect(await documentCount(c.companyId)).toBe(0);
    expect((await call(previewRoute, c.owner, "not-a-uuid", body([pdf]))).status).toBe(400);
  });
});
