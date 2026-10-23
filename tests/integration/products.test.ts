import { and, eq } from "drizzle-orm";
import { type Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type Actor } from "@/server/auth/authorization";
import { type Database } from "@/server/db/client";
import { auditLogs, taxCategories } from "@/server/db/schema";
import { UnauthenticatedError } from "@/server/errors";
import { call, issueCodes, params, req, routeHelpers } from "./route-helpers";
import { addFixtureTaxCategories } from "../support/tax-category-fixtures";
import { openTestDb } from "./test-db";

/**
 * Product catalog over the real route handlers, services and database (only the session lookup
 * is stubbed): prices, SKU uniqueness, the default tax category (same company, active),
 * permissions, tenant isolation, versions and the audit trail. Synthetic data only.
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

const collection = await import("@/app/api/companies/[companyId]/products/route");
const single = await import("@/app/api/companies/[companyId]/products/[productId]/route");

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
  list: (companyId: string, query = "") =>
    call(
      collection.GET(req("GET", undefined, `http://localhost/api?${query}`), params({ companyId })),
    ),
  create: (companyId: string, body: unknown) =>
    call(collection.POST(req("POST", body), params({ companyId }))),
  get: (companyId: string, productId: string) =>
    call(single.GET(req("GET"), params({ companyId, productId }))),
  patch: (companyId: string, productId: string, body: unknown) =>
    call(single.PATCH(req("PATCH", body), params({ companyId, productId }))),
};

async function companyWithCategories() {
  const c = await h.newCompany();
  const cats = await addFixtureTaxCategories(db, c.owner, c.companyId);
  return { ...c, cats };
}

const JACKET = {
  name: "Winter jacket (TEST)",
  sku: " wj-001 ",
  unit: "pcs",
  salePrice: "65,5",
  purchasePrice: "40.1200",
  trackStock: true,
};

describe("products API", () => {
  it("adds a product with normalized SKU and prices and a default tax category", async () => {
    const { owner, companyId, cats } = await companyWithCategories();
    as(owner);
    const taxCategoryId = Object.values(cats)[0]!;
    const created = await api.create(companyId, { ...JACKET, taxCategoryId });
    expect(created.status).toBe(201);
    expect(created.body.product).toMatchObject({
      kind: "goods",
      sku: "WJ-001",
      name: "Winter jacket (TEST)",
      currency: "EUR",
      salePrice: "65.5",
      purchasePrice: "40.12",
      taxCategoryId,
      trackStock: true,
      archived: false,
      version: 1,
    });
    // A service never tracks stock.
    const service = await api.create(companyId, {
      name: "Repair hour",
      kind: "service",
      unit: "h",
      trackStock: true,
    });
    expect(service.body.product).toMatchObject({
      kind: "service",
      trackStock: false,
      salePrice: null,
    });

    expect((await api.list(companyId)).body.products.map((p: { name: string }) => p.name)).toEqual([
      "Repair hour",
      "Winter jacket (TEST)",
    ]);
    for (const q of ["jacket", "wj-0"])
      expect((await api.list(companyId, `q=${q}`)).body.products).toHaveLength(1);
    expect((await api.get(companyId, created.body.product.id)).body.product.sku).toBe("WJ-001");
  });

  it("reports every invalid field; checks the tax category belongs to the company and is active", async () => {
    const { owner, companyId, cats } = await companyWithCategories();
    const other = await companyWithCategories();
    as(owner);
    const res = await api.create(companyId, {
      name: " ",
      unit: " ",
      currency: "USD",
      salePrice: "-1",
      purchasePrice: "1.23456",
      taxCategoryId: Object.values(other.cats)[0],
    });
    expect(res.status).toBe(422);
    expect(issueCodes(res.body)).toEqual([
      "product.currency.invalid",
      "product.name.required",
      "product.price.invalid",
      "product.price.invalid",
      "product.taxCategory.unknown",
      "product.unit.required",
    ]);
    const catId = Object.values(cats)[0]!;
    await db
      .update(taxCategories)
      .set({ archivedAt: new Date() })
      .where(eq(taxCategories.id, catId));
    const archived = await api.create(companyId, { name: "X", taxCategoryId: catId });
    expect(issueCodes(archived.body)).toEqual(["product.taxCategory.archived"]);
  });

  it("keeps SKUs unique among active products; edits with versions; an archived category stays until changed", async () => {
    const { owner, companyId, cats } = await companyWithCategories();
    as(owner);
    const [catA, catB] = Object.values(cats);
    const p = (await api.create(companyId, { ...JACKET, taxCategoryId: catA })).body.product;
    expect(await api.create(companyId, { name: "Other", sku: "wj-001" })).toMatchObject({
      status: 409,
      body: { error: "sku_taken" },
    });
    // The category is archived later: the product keeps it and other edits still work.
    await db
      .update(taxCategories)
      .set({ archivedAt: new Date() })
      .where(eq(taxCategories.id, catA!));
    const edited = await api.patch(companyId, p.id, { expectedVersion: 1, salePrice: "70" });
    expect(edited.body.product).toMatchObject({ salePrice: "70", taxCategoryId: catA, version: 2 });
    expect((await api.patch(companyId, p.id, { expectedVersion: 1, name: "Stale" })).status).toBe(
      409,
    );
    // Same values → no new version (prices compare as numbers).
    expect(
      (await api.patch(companyId, p.id, { expectedVersion: 2, salePrice: "70.0000" })).body.product
        .version,
    ).toBe(2);
    expect(
      (await api.patch(companyId, p.id, { expectedVersion: 2, taxCategoryId: catB })).body.product,
    ).toMatchObject({
      taxCategoryId: catB,
      version: 3,
    });

    expect(
      (await api.patch(companyId, p.id, { expectedVersion: 3, archived: true })).body.product
        .archived,
    ).toBe(true);
    const again = await api.create(companyId, { name: "Jacket v2", sku: "WJ-001" });
    expect(again.status).toBe(201);
    expect(await api.patch(companyId, p.id, { expectedVersion: 4, archived: false })).toMatchObject(
      {
        status: 409,
        body: { error: "sku_taken" },
      },
    );

    const audit = await db
      .select({ action: auditLogs.action })
      .from(auditLogs)
      .where(and(eq(auditLogs.companyId, companyId), eq(auditLogs.entityId, p.id)));
    expect(audit.map((a) => a.action).sort()).toEqual([
      "product.archived",
      "product.created",
      "product.updated",
      "product.updated",
    ]);
  });

  it("checks permissions and isolates companies", async () => {
    const a = await companyWithCategories();
    const b = await companyWithCategories();
    as(a.owner);
    const p = (await api.create(a.companyId, JACKET)).body.product;

    // Warehouse and production employees see the catalog but cannot change it.
    for (const role of ["warehouse_employee", "production_employee", "accountant"]) {
      as(await h.member(a.companyId, role));
      expect((await api.list(a.companyId)).status, role).toBe(200);
      expect((await api.create(a.companyId, { name: "X" })).status, role).toBe(403);
    }
    as(await h.member(a.companyId, "manager"));
    expect((await api.patch(a.companyId, p.id, { expectedVersion: 1, unit: "box" })).status).toBe(
      200,
    );
    as(await h.customMember(a.companyId, []));
    expect((await api.list(a.companyId)).status).toBe(403);

    as(b.owner);
    expect((await api.list(a.companyId)).status).toBe(403);
    expect((await api.get(b.companyId, p.id)).status).toBe(404);
    expect(
      (await api.patch(b.companyId, p.id, { expectedVersion: 2, name: "Hijack" })).status,
    ).toBe(404);
    as(null);
    expect((await api.list(a.companyId)).status).toBe(401);
  });
});
