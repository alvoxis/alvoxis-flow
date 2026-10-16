import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { type Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDraft,
  getDocument,
  issueDocument,
} from "@/modules/documents/server/document-service";
import { ensureDefaultNumberSeries } from "@/modules/documents/server/numbering-service";
import { type Actor } from "@/server/auth/authorization";
import { type Database } from "@/server/db/client";
import { companies, users } from "@/server/db/schema";
import { UnauthenticatedError } from "@/server/errors";
import { createCompanyWithOwner } from "@/server/tenancy/company-service";
import { FIXTURE_SELLER_PROFILE, invoiceDraft } from "../support/document-fixtures";
import {
  addFixtureTaxCategories,
  type FixtureCategoryIds,
  withCategoryIds,
} from "../support/tax-category-fixtures";
import { openTestDb } from "./test-db";

/**
 * Stage A: `buyerName` in the document list API (`GET …/documents`), through the real route,
 * services and database (only the session lookup is stubbed). Synthetic data only.
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

async function newCompany() {
  const [u] = await db
    .insert(users)
    .values({ email: `a-${randomUUID()}@example.test` })
    .returning();
  const owner = actorOf(u!.id);
  const { companyId } = await createCompanyWithOwner(db, owner, { name: "A Co", country: "LV" });
  await db.update(companies).set(FIXTURE_SELLER_PROFILE).where(eq(companies.id, companyId));
  await ensureDefaultNumberSeries(db, owner, companyId);
  const cats = await addFixtureTaxCategories(db, owner, companyId);
  return { owner, companyId, cats };
}

function input(cats: FixtureCategoryIds, buyerName: string) {
  const { lines, relation: _r, ...rest } = invoiceDraft({ buyer: { name: buyerName } });
  return {
    ...rest,
    lines: withCategoryIds(
      lines.map(({ id: _i, sourceLineId: _s, ...l }) => l),
      cats,
    ),
  };
}

async function list(actor: Actor, companyId: string) {
  session.actor = actor;
  const res = await collection.GET(new Request("http://localhost/api"), {
    params: Promise.resolve({ companyId }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

describe("buyerName in the document list", () => {
  it("is returned for drafts and issued documents; issued ones match their frozen snapshot", async () => {
    const { owner, companyId, cats } = await newCompany();
    const draft = await createDraft(db, owner, companyId, input(cats, "Melnraksta Pircējs SIA"));
    const toIssue = await createDraft(db, owner, companyId, input(cats, "Izrakstīts Pircējs SIA"));
    const issued = await issueDocument(db, owner, companyId, toIssue.id, 1);
    const empty = await createDraft(db, owner, companyId, input(cats, ""));

    const res = await list(owner, companyId);
    expect(res.status).toBe(200);
    const byId = new Map(
      res.body.documents.map((d: { id: string; buyerName: string | null }) => [d.id, d.buyerName]),
    );
    expect(byId.get(draft.id)).toBe("Melnraksta Pircējs SIA");
    expect(byId.get(empty.id)).toBe(""); // shown as "—" in the UI
    const snapshot = await getDocument(db, owner, companyId, issued.id);
    expect(snapshot.status).toBe("issued");
    expect(byId.get(issued.id)).toBe(snapshot.draft.buyer.name);
    expect(byId.get(issued.id)).toBe("Izrakstīts Pircējs SIA");
  });

  it("lists only the company's own documents; other companies and non-members get nothing", async () => {
    const a = await newCompany();
    const b = await newCompany();
    const own = await createDraft(db, a.owner, a.companyId, input(a.cats, "Uzņēmuma A pircējs"));
    await createDraft(db, b.owner, b.companyId, input(b.cats, "Uzņēmuma B pircējs"));

    const res = await list(a.owner, a.companyId);
    expect(res.body.documents.map((d: { id: string }) => d.id)).toEqual([own.id]);
    expect(JSON.stringify(res.body)).not.toContain("Uzņēmuma B pircējs");
    // Access rules are unchanged: a member of B cannot list A.
    expect((await list(b.owner, a.companyId)).status).toBe(403);
  });
});
