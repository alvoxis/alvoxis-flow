import { eq } from "drizzle-orm";
import { type Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type Actor } from "@/server/auth/authorization";
import { type Database } from "@/server/db/client";
import {
  createCreditNoteDraft,
  createDraft,
  issueDocument,
} from "@/modules/documents/server/document-service";
import { ensureDefaultNumberSeries } from "@/modules/documents/server/numbering-service";
import { companies } from "@/server/db/schema";
import { UnauthenticatedError } from "@/server/errors";
import { call, params, req, routeHelpers } from "./route-helpers";
import { FIXTURE_SELLER_PROFILE, invoiceDraft } from "../support/document-fixtures";
import { addFixtureTaxCategories, withCategoryIds } from "../support/tax-category-fixtures";
import { openTestDb } from "./test-db";

/**
 * Analytics and company settings (members) over the real route handlers, services and database
 * (only the session lookup is stubbed): sales per month and currency with credit notes
 * subtracted, top customers and lines, optional sections by permission; member role changes with
 * the owner rules. Synthetic data only.
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

const analyticsRoute = await import("@/app/api/companies/[companyId]/analytics/route");
const membersRoute = await import("@/app/api/companies/[companyId]/members/route");
const memberRoute = await import("@/app/api/companies/[companyId]/members/[membershipId]/route");

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

const h = routeHelpers(() => db);
const as = (actor: Actor | null) => {
  session.actor = actor;
};

const api = {
  analytics: (companyId: string, year: number) =>
    call(
      analyticsRoute.GET(
        req("GET", undefined, `http://localhost/api?year=${year}`),
        params({ companyId }),
      ),
    ),
  members: (companyId: string) => call(membersRoute.GET(req("GET"), params({ companyId }))),
  member: (companyId: string, membershipId: string, body: unknown) =>
    call(memberRoute.PATCH(req("PATCH", body), params({ companyId, membershipId }))),
};

/** A company with issued documents: EUR invoice (March, net 1100), its full credit note (March),
 *  an EUR invoice in May for another buyer, a PLN invoice (June), a proforma (not counted). */
async function companyWithSales() {
  const c = await h.newCompany("Analītika SIA");
  await db.update(companies).set(FIXTURE_SELLER_PROFILE).where(eq(companies.id, c.companyId));
  await ensureDefaultNumberSeries(db, c.owner, c.companyId);
  const cats = await addFixtureTaxCategories(db, c.owner, c.companyId);
  const draft = (over: Parameters<typeof invoiceDraft>[0] = {}) => {
    const { lines, relation: _r, bankAccounts: _b, ...rest } = invoiceDraft(over);
    return {
      ...rest,
      lines: withCategoryIds(
        lines.map(({ id: _id, sourceLineId: _s, ...l }) => l),
        cats,
      ),
    };
  };
  const issue = async (input: ReturnType<typeof draft>) => {
    const d = await createDraft(db, c.owner, c.companyId, input);
    return issueDocument(db, c.owner, c.companyId, d.id, d.version);
  };
  const march = await issue(draft());
  const note = await createCreditNoteDraft(db, c.owner, c.companyId, march.id, "full", {
    issueDate: "2026-03-10",
  });
  await issueDocument(db, c.owner, c.companyId, note.id, note.version);
  await issue(
    draft({
      issueDate: "2026-05-04",
      dueDate: "2026-05-18",
      buyer: { name: "Second Buyer SIA (TEST)" },
    }),
  );
  await issue(draft({ currency: "PLN", issueDate: "2026-06-01", dueDate: "2026-06-15" }));
  await issue(draft({ type: "proforma", issueDate: "2026-07-01", dueDate: undefined }));
  return c;
}

describe("analytics", () => {
  it("sums issued invoices and credit notes per month and currency, net of tax", async () => {
    const c = await companyWithSales();
    as(c.owner);
    const res = await api.analytics(c.companyId, 2026);
    expect(res.status).toBe(200);
    const a = res.body.analytics;
    expect(a.months).toEqual([
      { month: 3, currency: "EUR", net: "0.00", invoices: 1, creditNotes: 1 },
      { month: 5, currency: "EUR", net: "1100.00", invoices: 1, creditNotes: 0 },
      { month: 6, currency: "PLN", net: "1100.00", invoices: 1, creditNotes: 0 },
    ]);
    expect(a.customers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Second Buyer SIA (TEST)",
          currency: "EUR",
          net: "1100.00",
          documents: 1,
        }),
        // The March invoice and its full credit note cancel out.
        expect.objectContaining({
          name: "Sample Shipping Agency Ltd",
          currency: "EUR",
          net: "0.00",
          documents: 2,
        }),
      ]),
    );
    expect(
      a.items.find(
        (i: { description: string; currency: string }) =>
          i.description === "Winter jacket" && i.currency === "EUR",
      ),
    ).toMatchObject({ quantity: "10", net: "650.00" });
    expect(a.years).toEqual([2026]);
    // Owners see the optional sections (empty here).
    expect(a.stock).toEqual([]);
    expect(a.payroll).toEqual([]);
    expect(a.production).toEqual({ completed: 0, planned: 0 });
    expect((await api.analytics(c.companyId, 2025)).body.analytics.months).toEqual([]);
    expect((await api.analytics(c.companyId, 1999)).status).toBe(400);
  });

  it("shows only what the role may see and isolates companies", async () => {
    const c = await companyWithSales();
    const other = await h.newCompany();
    as(await h.member(c.companyId, "manager"));
    const manager = (await api.analytics(c.companyId, 2026)).body.analytics;
    expect(manager.months).toHaveLength(3);
    expect(manager.payroll).toBeNull();
    expect(manager.stock).not.toBeNull();
    for (const role of ["warehouse_employee", "production_employee"]) {
      as(await h.member(c.companyId, role));
      expect((await api.analytics(c.companyId, 2026)).status, role).toBe(403);
    }
    as(other.owner);
    expect((await api.analytics(c.companyId, 2026)).status).toBe(403);
    as(null);
    expect((await api.analytics(c.companyId, 2026)).status).toBe(401);
  });
});

describe("members", () => {
  it("changes roles and status with the owner rules", async () => {
    const c = await h.newCompany();
    const admin = await h.member(c.companyId, "administrator");
    await h.member(c.companyId, "accountant");
    as(c.owner);
    const list = (await api.members(c.companyId)).body;
    expect(list.roles.map((r: { key: string }) => r.key)).toContain("owner");
    const byRole = (key: string) =>
      list.members.find((m: { roleKey: string }) => m.roleKey === key) as { membershipId: string };
    const self = list.members.find((m: { isSelf: boolean }) => m.isSelf);
    expect(self.roleKey).toBe("owner");

    // Nobody changes their own membership; the last owner cannot be removed.
    expect((await api.member(c.companyId, self.membershipId, { roleKey: "manager" })).status).toBe(
      403,
    );
    const accountant = byRole("accountant");
    expect(
      (await api.member(c.companyId, accountant.membershipId, { roleKey: "manager" })).body.member,
    ).toMatchObject({
      roleKey: "manager",
    });
    expect(
      (await api.member(c.companyId, accountant.membershipId, { status: "suspended" })).body.member
        .status,
    ).toBe("suspended");

    // An administrator manages members but not owners, and cannot make anyone owner.
    as(admin);
    expect(
      (await api.member(c.companyId, accountant.membershipId, { status: "active" })).status,
    ).toBe(200);
    expect(
      (await api.member(c.companyId, accountant.membershipId, { roleKey: "owner" })).status,
    ).toBe(403);
    expect((await api.member(c.companyId, self.membershipId, { status: "suspended" })).status).toBe(
      403,
    );

    // A second owner, then the first may step down; the last owner stays.
    as(c.owner);
    expect(
      (await api.member(c.companyId, accountant.membershipId, { roleKey: "owner" })).status,
    ).toBe(200);
    as({
      userId: (await db.query.memberships.findFirst({
        where: (m, { eq: e }) => e(m.id, accountant.membershipId),
      }))!.userId,
      twoFactorVerified: true,
    });
    expect(
      (await api.member(c.companyId, self.membershipId, { roleKey: "administrator" })).status,
    ).toBe(200);
    // Now the promoted member is the only owner: demoting them is refused by the other side too.
    as(c.owner);
    expect(
      (await api.member(c.companyId, accountant.membershipId, { roleKey: "manager" })).status,
    ).toBe(403);
    expect(
      (await api.member(c.companyId, byRole("administrator").membershipId, { roleKey: "nope" }))
        .status,
    ).toBe(404);
  });

  it("requires members.view and isolates companies", async () => {
    const c = await h.newCompany();
    const other = await h.newCompany();
    as(await h.member(c.companyId, "warehouse_employee"));
    expect((await api.members(c.companyId)).status).toBe(403);
    as(await h.member(c.companyId, "accountant"));
    expect((await api.members(c.companyId)).status).toBe(200);
    const target = (await api.members(c.companyId)).body.members[0].membershipId;
    expect((await api.member(c.companyId, target, { status: "suspended" })).status).toBe(403);
    as(other.owner);
    expect((await api.members(c.companyId)).status).toBe(403);
    expect((await api.member(other.companyId, target, { status: "suspended" })).status).toBe(404);
  });
});
